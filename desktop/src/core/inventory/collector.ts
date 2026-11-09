// Collecte de l'inventaire (port d'`InventoryCollector`) : outils installés, marqueurs, historique, statuts.
// Tout est asynchrone (spawn en flux, fs/promises) : le main peut l'appeler sans geler l'interface.
import { constants } from "node:fs";
import { access, lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CairnConfig, folderExpandedPath } from "../config.ts";
import { ENV_EXECUTABLE, ProcessLaunchError, run, systemRunnerEnv, widePath } from "../process.ts";
import * as parse from "./parsers.ts";
import { BUNDLED_RULES, type InventoryRules } from "./rules.ts";
import {
  type CLITool,
  cliTool,
  EMPTY_INVENTORY,
  type Inventory,
  type InventoryEntry,
  type InventoryReason,
  type InventoryStatus,
  reasonEquals,
} from "./types.ts";

/** Lance une commande (cherchée dans le PATH élargi) ; injectable pour les tests. */
export type CommandRunner = (command: readonly string[]) => Promise<{ status: number; output: string }>;

/** `SystemRunner` : `/usr/bin/env <commande>`, PATH élargi, `HOMEBREW_NO_AUTO_UPDATE=1`, stderr ignoré. */
export function systemRunner(home: string = os.homedir()): CommandRunner {
  return async (command) => {
    try {
      const r = await run(ENV_EXECUTABLE, command, { env: systemRunnerEnv(process.env, home), stderr: "ignore" });
      return { status: r.code ?? 1, output: r.stdout };
    } catch (error) {
      if (error instanceof ProcessLaunchError) return { status: 127, output: "" };
      throw error;
    }
  };
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Fichier ordinaire exécutable (liens suivis), comme `isExecutableFile` + `!isDirectory`. */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    if (s.isDirectory()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Outils installés, toutes sources confondues. */
export async function installed(
  home: string = os.homedir(),
  runner: CommandRunner = systemRunner(home),
  rules: InventoryRules = BUNDLED_RULES,
): Promise<{ tools: CLITool[]; taps: string[] }> {
  const tools: CLITool[] = [];
  let taps: string[] = [];
  // Seules les formules installées à la demande : pas les dépendances devenues orphelines.
  const leaves = await runner(["brew", "leaves", "--installed-on-request"]);
  if (leaves.status === 0) {
    const names = parse.lines(leaves.output);
    if (names.length > 0) {
      const v = await runner(["brew", "list", "--versions", ...names]);
      tools.push(...parse.brewVersions(v.output, rules));
    }
    taps = parse.brewTaps((await runner(["brew", "tap"])).output);
  }
  const mise = await runner(["mise", "ls", "--current", "--json"]);
  if (mise.status === 0) tools.push(...parse.mise(mise.output, rules));
  const npm = await runner(["mise", "exec", "--", "npm", "ls", "-g", "--depth=0", "--json"]);
  if (npm.status === 0) tools.push(...parse.npmGlobals(npm.output, rules));

  const uvDir = path.join(home, ".local/share/uv/tools");
  for (const d of (await list(uvDir)).sort(byCodePoint)) {
    const toolDir = path.join(uvDir, d);
    const text = await readText(path.join(toolDir, "uv-receipt.toml"));
    const t = text === null ? null : parse.uvReceipt(text);
    if (t) tools.push({ ...t, version: await parse.uvVersion(t.name, toolDir) });
  }
  const pipx = await runner(["pipx", "list", "--short"]);
  if (pipx.status === 0) tools.push(...parse.pipx(pipx.output));
  const crates = await readText(path.join(home, ".cargo/.crates2.json"));
  if (crates !== null) tools.push(...parse.cargo(crates));
  const goBin = path.join(home, "go/bin");
  for (const name of (await list(goBin)).sort(byCodePoint)) {
    if (name.startsWith(".")) continue;
    // `go version -m` lit les informations de build sans lancer le binaire (null si go est absent).
    const info = await runner(["go", "version", "-m", path.join(goBin, name)]);
    tools.push(cliTool(name, "go", info.status === 0 ? parse.goVersion(info.output) : null, [name]));
  }
  const localDir = path.join(home, ".local/bin");
  const local: parse.LocalBinEntry[] = [];
  for (const name of (await list(localDir)).sort(byCodePoint)) {
    const p = path.join(localDir, name);
    if (name.startsWith(".") || !(await isExecutableFile(p))) continue;
    let linkTarget: string | null = null;
    try {
      if ((await lstat(p)).isSymbolicLink()) linkTarget = await readlink(p);
    } catch {}
    local.push({ name, linkTarget });
  }
  tools.push(...parse.localBin(local));
  return { tools, taps };
}

/** Dossiers jamais parcourus pour les marqueurs de projet (en plus des dossiers cachés). */
const MARKER_SKIP = new Set([
  "node_modules",
  ".git",
  ".pnpm-store",
  "vendor",
  "Pods",
  "DerivedData",
  ".venv",
  "dist",
  "build",
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
]);

/** Fichiers de projet présents dans les dossiers suivis (profondeur limitée, dossiers régénérables ignorés). */
export async function projectMarkers(
  folders: readonly string[],
  names: ReadonlySet<string>,
  maxDepth = 5,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.size >= names.size) return;
    let items: import("node:fs").Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (names.has(item.name) && !found.has(item.name)) found.set(item.name, `${dir}/${item.name}`);
    }
    for (const item of items) {
      // Les liens ne sont pas suivis (`Dirent.isDirectory()` est faux pour un lien).
      if (MARKER_SKIP.has(item.name) || item.name.startsWith(".") || !item.isDirectory()) continue;
      await walk(`${dir}/${item.name}`, depth + 1);
    }
  }
  for (const f of folders) await walk(f, 0);
  return found;
}

/** Une commande est-elle disponible dans le PATH élargi ? */
export async function isAvailable(command: string, home: string = os.homedir()): Promise<boolean> {
  for (const dir of widePath(home).split(":")) {
    if (await isExecutableFile(`${dir}/${command}`)) return true;
  }
  return false;
}

export interface ClassifyInput {
  tools: readonly CLITool[];
  taps: readonly string[];
  homeMarkers: ReadonlySet<string>;
  projectMarkers: ReadonlySet<string>;
  history: ReadonlyMap<string, number>;
  excluded: ReadonlySet<string>;
  rules?: InventoryRules;
  /** Commande trouvée dans le PATH élargi (voir `availableCommands`). Défaut : aucune. */
  available?: (command: string) => boolean;
}

/** Commandes requises par les règles pour ces marqueurs (candidates au statut `missing`). */
export function requiredCommands(
  homeMarkers: ReadonlySet<string>,
  projectMarkers: ReadonlySet<string>,
  rules: InventoryRules = BUNDLED_RULES,
): Map<string, InventoryReason[]> {
  const reasons = new Map<string, InventoryReason[]>();
  const add = (cmd: string, r: InventoryReason) => {
    const list = reasons.get(cmd) ?? [];
    list.push(r);
    reasons.set(cmd, list);
  };
  for (const [marker, cmds] of Object.entries(rules.home)) {
    if (homeMarkers.has(marker)) for (const c of cmds) add(c, { code: "home", file: marker });
  }
  for (const [marker, cmds] of Object.entries(rules.projects)) {
    if (projectMarkers.has(marker)) for (const c of cmds) add(c, { code: "project", file: marker });
  }
  return reasons;
}

const STATUS_ORDER: Record<InventoryStatus, number> = { missing: 0, used: 1, unused: 2 };

/** Statuts : utilisé (configuration du home, projet, historique), non utilisé, requis manquant. */
export function classify(input: ClassifyInput): Inventory {
  const rules = input.rules ?? BUNDLED_RULES;
  const available = input.available ?? (() => false);
  const reasonsByCommand = requiredCommands(input.homeMarkers, input.projectMarkers, rules);
  const entries: InventoryEntry[] = [];
  const provided = new Set<string>();
  for (const t of input.tools) {
    const reasons: InventoryReason[] = [];
    let uses = 0;
    for (const c of t.commands) {
      provided.add(c);
      for (const r of reasonsByCommand.get(c) ?? []) if (!reasons.some((x) => reasonEquals(x, r))) reasons.push(r);
      uses += input.history.get(c) ?? 0;
    }
    // Une seule raison « historique » par outil, toutes commandes confondues.
    if (uses >= rules.historyMinUses) reasons.push({ code: "history", uses });
    entries.push({
      name: t.name,
      tool: t,
      status: reasons.length === 0 ? "unused" : "used",
      reasons,
      excluded: input.excluded.has(t.name),
    });
  }
  for (const cmd of [...reasonsByCommand.keys()].sort(byCodePoint)) {
    if (provided.has(cmd) || available(cmd)) continue;
    entries.push({
      name: cmd,
      tool: null,
      status: "missing",
      reasons: reasonsByCommand.get(cmd) ?? [],
      excluded: false,
    });
  }
  entries.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      byCodePoint(a.tool?.source ?? "", b.tool?.source ?? "") ||
      byCodePoint(a.name, b.name),
  );
  return { entries, taps: [...input.taps] };
}

/** Commandes de `candidates` présentes dans le PATH élargi. */
export async function availableCommands(
  candidates: Iterable<string>,
  home: string = os.homedir(),
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of candidates) if (await isAvailable(c, home)) out.add(c);
  return out;
}

/** Nombre d'utilisations des commandes dans `.zsh_history` et `.bash_history`. */
export async function shellHistory(home: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const f of [".zsh_history", ".bash_history"]) {
    // L'historique zsh n'est pas toujours de l'UTF-8 valide : caractères invalides remplacés, comme Swift.
    const text = await readText(path.join(home, f));
    if (text === null) continue;
    for (const [cmd, n] of parse.history(text)) counts.set(cmd, (counts.get(cmd) ?? 0) + n);
  }
  return counts;
}

export interface CollectOptions {
  home?: string;
  /** Exécuteur injecté (tests) ; sans lui, `CAIRN_TOOLS_INVENTORY=empty` donne un inventaire vide. */
  runner?: CommandRunner;
  rules?: InventoryRules;
}

/**
 * Inventaire complet de la machine. En test (`CAIRN_TOOLS_INVENTORY=empty`, posé par `test/setup.ts`, équivalent de
 * `BackupService.collectInventory` remplacé dans TestSupport.swift), l'inventaire réel est vide : ni brew, ni mise…
 * Un exécuteur injecté passe outre (les tests de collecte fournissent leurs sorties).
 */
export async function collect(config: CairnConfig, options: CollectOptions = {}): Promise<Inventory> {
  if (!options.runner && process.env.CAIRN_TOOLS_INVENTORY === "empty") {
    return { entries: [], taps: [...EMPTY_INVENTORY.taps] };
  }
  const home = options.home ?? os.homedir();
  const rules = options.rules ?? BUNDLED_RULES;
  const { tools, taps } = await installed(home, options.runner ?? systemRunner(home), rules);
  const homeMarkers = new Set<string>();
  for (const marker of Object.keys(rules.home)) if (await exists(path.join(home, marker))) homeMarkers.add(marker);
  const projects = new Set(
    (await projectMarkers(config.folders.map(folderExpandedPath), new Set(Object.keys(rules.projects)))).keys(),
  );
  const history = await shellHistory(home);
  const provided = new Set(tools.flatMap((t) => t.commands));
  const candidates = [...requiredCommands(homeMarkers, projects, rules).keys()].filter((c) => !provided.has(c));
  const available = await availableCommands(candidates, home);
  return classify({
    tools,
    taps,
    homeMarkers,
    projectMarkers: projects,
    history,
    excluded: new Set(config.excludedTools),
    rules,
    available: (c) => available.has(c),
  });
}
