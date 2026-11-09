// Lecteurs des sorties des gestionnaires de paquets (fonctions pures, testées sur des sorties enregistrées).
// Port d'`InventoryParsers` : mêmes découpages que Swift (`split` sans éléments vides).
import path from "node:path";
import { readdir } from "../fs-promises.ts";
import { asArray, asInlineTable, asString, TOMLDocument, type TOMLTable, type TOMLValue } from "../toml.ts";
import { BUNDLED_RULES, commandsFor, type InventoryRules } from "./rules.ts";
import { type CLITool, cliTool } from "./types.ts";

/** Lignes non vides (comme `split(separator: "\n")`). */
export function lines(text: string): string[] {
  return text.split("\n").filter((l) => l !== "");
}

/** Mots séparés par des espaces, sans éléments vides. */
function words(text: string): string[] {
  return text.split(" ").filter((w) => w !== "");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `brew list --versions <formules>` : « nom version [version…] ». */
export function brewVersions(text: string, rules: InventoryRules = BUNDLED_RULES): CLITool[] {
  return lines(text).flatMap((line) => {
    const parts = words(line);
    const name = parts[0];
    if (name === undefined) return [];
    const last = parts.at(-1) as string;
    return [cliTool(name, "brew", last === name ? null : last, commandsFor(name, rules))];
  });
}

/** `brew tap`. */
export function brewTaps(text: string): string[] {
  return lines(text)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** `mise ls --current --json`. */
export function mise(text: string, rules: InventoryRules = BUNDLED_RULES): CLITool[] {
  const obj = parseJSON(text);
  // Comme `as? [String: [[String: Any]]]` : une valeur mal formée invalide le tout.
  if (!isObject(obj)) return [];
  for (const v of Object.values(obj)) if (!Array.isArray(v) || !v.every(isObject)) return [];
  const table = obj as Record<string, Record<string, unknown>[]>;
  return Object.keys(table)
    .sort(byCodePoint)
    .map((key) => {
      const versions = table[key] ?? [];
      const active = versions.find((v) => v.active === true) ?? versions[0];
      const version = typeof active?.version === "string" ? active.version : null;
      // « npm:@scope/pkg », « cargo:x », « ubi:owner/repo » : la commande vient du nom du paquet.
      const colon = key.indexOf(":");
      const pkg = colon >= 0 && colon < key.length - 1 ? key.slice(colon + 1) : key.replace(/:$/, "");
      const details: Record<string, string> = {};
      if (typeof active?.requested_version === "string") details.requested = active.requested_version;
      return cliTool(key, "mise", version, commandsFor(pkg, rules), details);
    });
}

/** `npm ls -g --depth=0 --json` (npm et corepack exclus : ils viennent avec Node). */
export function npmGlobals(text: string, rules: InventoryRules = BUNDLED_RULES): CLITool[] {
  const obj = parseJSON(text);
  if (!isObject(obj) || !isObject(obj.dependencies)) return [];
  const deps = obj.dependencies;
  if (!Object.values(deps).every(isObject)) return [];
  return Object.keys(deps)
    .sort(byCodePoint)
    .filter((n) => n !== "npm" && n !== "corepack")
    .map((name) => {
      const v = (deps[name] as Record<string, unknown>).version;
      return cliTool(name, "npm", typeof v === "string" ? v : null, commandsFor(name, rules));
    });
}

function inlineRecord(v: TOMLValue | undefined): Map<string, TOMLValue> | undefined {
  const table = asInlineTable(v);
  if (!table) return undefined;
  const out = new Map<string, TOMLValue>();
  for (const [k, value] of table) if (!out.has(k)) out.set(k, value); // la première l'emporte
  return out;
}

/** Reçu `uv-receipt.toml` d'un outil uv (version lue à part, voir `uvVersion`). */
export function uvReceipt(text: string): CLITool | null {
  let tool: TOMLTable | undefined;
  try {
    tool = TOMLDocument.parse(text).tree().table("tool");
  } catch {
    return null;
  }
  if (!tool) return null;
  const req = inlineRecord(asArray(tool.value("requirements"))?.[0]);
  const name = asString(req?.get("name"));
  if (!req || name === undefined) return null;
  const details: Record<string, string> = {};
  const extras = (asArray(req.get("extras")) ?? []).map(asString).filter((s): s is string => s !== undefined);
  if (extras.length > 0) details.extras = extras.join(",");
  const python = asString(tool.value("python"));
  if (python !== undefined) details.python = python;
  const entrypoints = asArray(tool.value("entrypoints"));
  const commands = entrypoints
    ? entrypoints.map((e) => asString(inlineRecord(e)?.get("name"))).filter((s): s is string => s !== undefined)
    : [name];
  return cliTool(name, "uv", null, commands, details);
}

/** Noms comparés normalisés (casse, `-`, `_` et `.` équivalents) : `serena-agent` ≡ `serena_agent`. */
function normalizePackage(s: string): string {
  return s.toLowerCase().replace(/[-_.]+/g, "_");
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Version d'un outil uv lue dans son environnement : `lib/python*\/site-packages/<nom>-<version>.dist-info`.
 */
export async function uvVersion(name: string, toolDir: string): Promise<string | null> {
  const lib = path.join(toolDir, "lib");
  for (const py of (await list(lib)).sort(byCodePoint)) {
    if (!py.startsWith("python")) continue;
    for (const entry of await list(path.join(lib, py, "site-packages"))) {
      if (!entry.endsWith(".dist-info")) continue;
      const stem = entry.slice(0, -".dist-info".length);
      // La version ne contient jamais de tiret : le dernier sépare le nom de la version.
      const dash = stem.lastIndexOf("-");
      if (dash < 0) continue;
      if (normalizePackage(stem.slice(0, dash)) === normalizePackage(name)) return stem.slice(dash + 1);
    }
  }
  return null;
}

/** `go version -m <binaire>` : la ligne `mod <module> <version>` donne la version (rien pour `(devel)`). */
export function goVersion(text: string): string | null {
  for (const line of lines(text)) {
    const f = line.split(/[\t ]/).filter((w) => w !== "");
    if (f.length >= 3 && f[0] === "mod") return f[2] === "(devel)" ? null : (f[2] as string);
  }
  return null;
}

const versionSegment = /^v?\d+(\.\d+)+([-+][0-9A-Za-z.]+)?$/;

/** Version présente dans le chemin d'un lien (`~/.local/share/claude/versions/2.1.3` → « 2.1.3 »), sinon null. */
export function versionInPath(p: string): string | null {
  const segments = p.split("/").filter((s) => s !== "");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (versionSegment.test(segments[i] as string)) return segments[i] as string;
  }
  return null;
}

/** `pipx list --short` : « nom version ». */
export function pipx(text: string): CLITool[] {
  return lines(text).flatMap((line) => {
    const p = words(line);
    const name = p[0];
    if (name === undefined) return [];
    return [cliTool(name, "pipx", p[1] ?? null, [name])];
  });
}

/** `~/.cargo/.crates2.json`. */
export function cargo(text: string): CLITool[] {
  const obj = parseJSON(text);
  if (!isObject(obj) || !isObject(obj.installs)) return [];
  const installs = obj.installs;
  if (!Object.values(installs).every(isObject)) return [];
  return Object.keys(installs)
    .sort(byCodePoint)
    .flatMap((key) => {
      const p = words(key);
      const name = p[0];
      if (name === undefined) return [];
      const bins = (installs[key] as Record<string, unknown>).bins;
      const commands = Array.isArray(bins) && bins.every((b) => typeof b === "string") ? (bins as string[]) : [name];
      return [cliTool(name, "cargo", p[1] ?? null, commands)];
    });
}

export interface LocalBinEntry {
  name: string;
  linkTarget: string | null;
}

/** Exécutables de `~/.local/bin` : les liens vers un environnement uv ou pipx sont rattachés à leur source. */
export function localBin(entries: readonly LocalBinEntry[]): CLITool[] {
  const names = new Set(entries.map((e) => e.name));
  return entries.flatMap((e) => {
    const target = e.linkTarget;
    if (target !== null) {
      if (target.includes("/uv/tools/") || target.includes("/pipx/venvs/")) return [];
      // Alias vers un autre exécutable du même dossier (cr → coderabbit).
      if (target.includes("/.local/bin/") && names.has(path.basename(target))) return [];
    }
    const details: Record<string, string> = {};
    if (target !== null) details.link = target;
    // Pas d'exécution de `--version` sur un binaire inconnu : seule la cible du lien peut donner la version.
    return [cliTool(e.name, "local-bin", target === null ? null : versionInPath(target), [e.name], details)];
  });
}

const prefixes = new Set(["sudo", "rtk", "time", "exec", "nohup"]);
const commandPattern = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** Nombre d'utilisations de chaque commande dans un historique zsh (format étendu) ou bash. */
export function history(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of lines(text)) {
    let line = raw;
    if (line.startsWith(": ")) {
      const semi = line.indexOf(";");
      if (semi >= 0) line = line.slice(semi + 1);
    }
    const w = line.split(/[ \t]/).filter((s) => s !== "");
    if (w[0] !== undefined && prefixes.has(w[0])) w.shift();
    const cmd = w[0];
    if (cmd === undefined || !commandPattern.test(cmd)) continue;
    counts.set(cmd, (counts.get(cmd) ?? 0) + 1);
  }
  return counts;
}
