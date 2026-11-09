// Sauvegarde des outils IA (port d'`AIBackup`) : catégories, parties `ai/<id>/<cat>` et `ai/<id>/meta`,
// identifiants seulement vers des destinations chiffrées, outils ouverts.
import os from "node:os";
import path from "node:path";
import type { BackupPart } from "../backup/types.ts";
import type { AIToolConfig, CairnConfig } from "../config.ts";
import { mkdir, readdir, readFile, stat, writeFile } from "../fs-promises.ts";
import { type JSONValue, prettyJSON } from "../json.ts";
import { t } from "../l10n.ts";
import { run } from "../process.ts";
import { asBool, asString, TOMLDocument, type TOMLTable } from "../toml.ts";
import { globMatch } from "./glob.ts";
import { type AIProfile, BUNDLED_PROFILES, isDetected, rootPath } from "./profiles.ts";
import { snapshot } from "./sqlite.ts";

/** Partie de sauvegarde d'un outil IA (`kind` = `ai`). */
export type AIBackupPart = BackupPart & { kind: "ai" };

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
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

/** Développe les entrées d'une catégorie (dossiers « x/ », fichiers, motifs « a/*.json ») en chemins existants. */
export async function expandEntries(entries: readonly string[], root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries) {
    const clean = e.endsWith("/") ? e.slice(0, -1) : e;
    if (clean.includes("*")) {
      // Motif dans le dernier segment seulement (`fnmatch`).
      const slash = clean.lastIndexOf("/");
      const dir = slash >= 0 ? clean.slice(0, slash) : "";
      const pattern = slash >= 0 ? clean.slice(slash + 1) : clean;
      const base = dir === "" ? root : `${root}/${dir}`;
      for (const name of (await list(base)).sort(byCodePoint)) {
        if (globMatch(pattern, name)) out.push(dir === "" ? name : `${dir}/${name}`);
      }
    } else if (await exists(`${root}/${clean}`)) {
      out.push(clean);
    }
  }
  return out;
}

/** Base SQLite d'après les motifs `sqlite` du profil (chemin relatif ou nom). */
export function isDatabase(rel: string, p: AIProfile): boolean {
  return p.sqlite.some((pat) => globMatch(pat, rel) || globMatch(pat, path.basename(rel)));
}

export interface Resolved {
  /** Chemins relatifs à la racine, par catégorie (fichiers ordinaires et dossiers), hors bases SQLite. */
  files: Record<string, string[]>;
  /** Bases SQLite par catégorie (copiées par snapshot). */
  databases: Record<string, string[]>;
}

export async function resolveCategories(
  p: AIProfile,
  categories: readonly string[],
  home: string = os.homedir(),
): Promise<Resolved> {
  const root = rootPath(p, home);
  const r: Resolved = { files: {}, databases: {} };
  for (const cat of categories) {
    const paths = await expandEntries(p.categories[cat] ?? [], root);
    r.files[cat] = paths.filter((x) => !isDatabase(x, p));
    r.databases[cat] = paths.filter((x) => isDatabase(x, p));
  }
  return r;
}

// MARK: Identifiants

/** Pourquoi les identifiants ne sont pas sauvegardés : aucune destination, ou une destination non chiffrée. */
export type CredentialsBlock = "no_destination" | "unencrypted_destination";

/** Raison du retrait des identifiants (null : toutes les destinations sont chiffrées). */
export function credentialsBlock(config: CairnConfig): CredentialsBlock | null {
  if (config.destinations.length === 0) return "no_destination";
  return config.destinations.every((d) => d.encrypted) ? null : "unencrypted_destination";
}

/**
 * Les identifiants ne partent que si toutes les destinations sont chiffrées (les parties sont communes à toutes les
 * destinations d'une sauvegarde).
 */
export function credentialsAllowed(config: CairnConfig): boolean {
  return credentialsBlock(config) === null;
}

/** Texte affiché à côté de la case « identifiants » désactivée (infobulle), null si elle est disponible. */
export function credentialsBlockText(config: CairnConfig): string | null {
  return credentialsBlock(config) === null ? null : t("ai.credentials.ignored");
}

/**
 * Catégories réellement sauvegardées pour un outil configuré : `credentials` retiré, même cochée, si une destination
 * n'est pas chiffrée ou s'il n'y en a aucune (spec ai-tools modifiée).
 */
export function effectiveCategories(tool: AIToolConfig, config: CairnConfig): string[] {
  return credentialsAllowed(config) ? [...tool.categories] : tool.categories.filter((c) => c !== "credentials");
}

// MARK: Outils ouverts

/** Lit les processus en cours (`pgrep -lx`) ; injectable pour les tests. */
export type ProcessLister = (names: readonly string[]) => Promise<string[]>;

/** `pgrep -lx <noms|…>` : noms des processus des outils IA ouverts. */
export const pgrep: ProcessLister = async (names) => {
  if (names.length === 0) return [];
  try {
    const r = await run("/usr/bin/pgrep", ["-lx", names.join("|")], { stderr: "ignore" });
    return r.stdout
      .split("\n")
      .filter((l) => l !== "")
      .flatMap((l) => {
        const w = l.split(" ").filter((x) => x !== "");
        return w.length > 0 ? [w.at(-1) as string] : [];
      });
  } catch {
    return [];
  }
};

/** Processus des outils IA ouverts (noms tirés des profils) : la copie reste cohérente grâce aux snapshots. */
export async function runningApps(
  profiles: readonly AIProfile[] = BUNDLED_PROFILES,
  lister: ProcessLister = pgrep,
): Promise<string[]> {
  const names = [...new Set(profiles.flatMap((p) => p.processes ?? []))].sort(byCodePoint);
  if (names.length === 0) return [];
  return lister(names);
}

export interface OpenToolsOptions {
  home?: string;
  profiles?: readonly AIProfile[];
  /** Processus en cours (sinon `pgrep`). */
  running?: readonly string[];
}

/** Outils configurés et détectés qui sont ouverts (identifiants), d'après les processus de leur profil. */
export async function openTools(config: CairnConfig, options: OpenToolsOptions = {}): Promise<string[]> {
  const home = options.home ?? os.homedir();
  const profiles = options.profiles ?? BUNDLED_PROFILES;
  const configured: AIProfile[] = [];
  for (const p of profiles) {
    if (config.ai.some((a) => a.id === p.id) && (await isDetected(p, home))) configured.push(p);
  }
  const names = new Set(options.running ?? (await runningApps(configured)));
  return configured.filter((p) => (p.processes ?? []).some((n) => names.has(n))).map((p) => p.id);
}

/** Ligne du journal de sauvegarde pour les outils ouverts (null si aucun). */
export async function openToolsLogLine(config: CairnConfig, options: OpenToolsOptions = {}): Promise<string | null> {
  const open = await openTools(config, options);
  if (open.length === 0) return null;
  return `ai: open during backup (SQLite copied by snapshot): ${open.join(", ")}`;
}

// MARK: Plugins

async function readJSONObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(file, "utf8")) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Plugins et marketplaces déclarés par l'outil (null si l'outil n'en déclare pas ou fichier illisible). */
export async function declaredPlugins(p: AIProfile, home: string = os.homedir()): Promise<JSONValue | null> {
  const root = rootPath(p, home);
  switch (p.id) {
    case "claude-code": {
      // installed_plugins.json : { "plugins": { "nom@marketplace": [ { "version", "scope"… } ] } }
      const installed = await readJSONObject(`${root}/.claude/plugins/installed_plugins.json`);
      const markets = await readJSONObject(`${root}/.claude/plugins/known_marketplaces.json`);
      if (installed === null && markets === null) return null;
      const table = asObject(installed?.plugins) ?? {};
      const plugins = Object.keys(table)
        .sort(byCodePoint)
        .map((name) => {
          const e: Record<string, JSONValue> = { name };
          const entries = table[name];
          const first = Array.isArray(entries) && entries.every((x) => asObject(x)) ? asObject(entries[0]) : undefined;
          for (const k of ["version", "scope"]) if (typeof first?.[k] === "string") e[k] = first[k] as string;
          return e;
        });
      const marketplaces = Object.keys(markets ?? {})
        .sort(byCodePoint)
        .map((name) => {
          const e: Record<string, JSONValue> = { name };
          const src = asObject(asObject(markets?.[name])?.source);
          const s = src?.repo ?? src?.url ?? src?.path;
          if (typeof s === "string") e.source = s;
          return e;
        });
      return { plugins, marketplaces };
    }
    case "codex": {
      // config.toml : [plugins."nom@marketplace"] enabled = … et [marketplaces.<nom>] source = …
      let tree: TOMLTable;
      try {
        tree = TOMLDocument.parse(await readFile(`${root}/config.toml`, "utf8")).tree();
      } catch {
        return null;
      }
      const pt = tree.table("plugins");
      const mt = tree.table("marketplaces");
      if (!pt && !mt) return null;
      const plugins = [...(pt?.keys ?? [])].sort(byCodePoint).map((name) => {
        const e: Record<string, JSONValue> = { name };
        const on = asBool(pt?.table(name)?.value("enabled"));
        if (on !== undefined) e.enabled = on;
        return e;
      });
      const marketplaces = [...(mt?.keys ?? [])].sort(byCodePoint).map((name) => {
        const e: Record<string, JSONValue> = { name };
        const s = asString(mt?.table(name)?.value("source"));
        if (s !== undefined) e.source = s;
        return e;
      });
      return { plugins, marketplaces };
    }
    default:
      return null;
  }
}

// MARK: Parties

/** Contenu de `meta/profile.json` (format exact de la 0.8.0), relu par la restauration. */
export interface AIProfileMeta {
  profile: string;
  profile_version: number;
  home: string;
  root: string;
  categories: string[];
  /** Dossier réinstallé → noms non cachés qu'il contient. */
  reinstall: Record<string, string[]>;
  running: string[];
  plugins?: {
    plugins: Array<{ name: string; version?: string; scope?: string; enabled?: boolean }>;
    marketplaces: Array<{ name: string; source?: string }>;
  };
}

/** Lit `meta/profile.json` d'une version (`<version>/ai/<id>/meta/profile.json`), null s'il est illisible. */
export async function readProfileMeta(file: string): Promise<AIProfileMeta | null> {
  const o = await readJSONObject(file);
  if (!o || typeof o.profile !== "string") return null;
  return o as unknown as AIProfileMeta;
}

export interface AIPartsOptions {
  home?: string;
  profiles?: readonly AIProfile[];
  /** Avertissement (base impossible à copier) : la sauvegarde continue. */
  warn?: (message: string) => void;
  /** Processus en cours (sinon `pgrep`). */
  running?: readonly string[];
  /** Copie d'une base (tests). */
  snapshot?: (source: string, dest: string) => Promise<void>;
}

/**
 * Parties de sauvegarde des outils IA configurés : une partie par catégorie (fichiers), plus `ai/<outil>/meta`
 * (profil, liste à réinstaller, snapshots SQLite). Une base impossible à copier ne fait pas échouer la sauvegarde :
 * elle est signalée par `warn` (65c88bb).
 */
export async function aiParts(
  config: CairnConfig,
  staging: string,
  options: AIPartsOptions = {},
): Promise<AIBackupPart[]> {
  const home = options.home ?? os.homedir();
  const profiles = options.profiles ?? BUNDLED_PROFILES;
  const warn = options.warn ?? (() => {});
  const copy = options.snapshot ?? ((s: string, d: string) => snapshot(s, d));
  const parts: AIBackupPart[] = [];
  const running = options.running ? [...options.running] : await runningApps(profiles);
  for (const tool of config.ai) {
    const p = profiles.find((x) => x.id === tool.id);
    if (!p || !(await isDetected(p, home))) continue;
    const root = rootPath(p, home);
    const categories = effectiveCategories(tool, config);
    const resolved = await resolveCategories(p, categories, home);
    const meta = path.join(staging, `ai-${p.id}`);
    await mkdir(meta, { recursive: true });
    for (const cat of categories) {
      const files = resolved.files[cat] ?? [];
      if (files.length > 0) {
        // Un dossier réinstallé n'est pas exclu s'il contient un fichier demandé (listes de plugins de Claude Code
        // dans .claude/plugins/) : selon la version de rsync, l'exclusion du dossier parent l'emporterait sur
        // --files-from (RestoreWarningTests).
        const reinstall = p.reinstall.filter((r) => !files.some((f) => f.startsWith(r)));
        parts.push({
          kind: "ai",
          target: `ai/${p.id}/${cat}`,
          source: root,
          excludes: [...p.exclude, ...reinstall, "*-wal", "*-shm", ...p.sqlite],
          filesFrom: files,
        });
      }
      for (const db of resolved.databases[cat] ?? []) {
        try {
          await copy(`${root}/${db}`, path.join(meta, "sqlite", cat, db));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          warn(t("backup.warning.ai_database", `ai/${p.id}/${cat}`, detail));
        }
      }
    }
    // Éléments réinstallés plutôt que copiés : seulement leur liste (noms de dossiers en repli, plugins et
    // marketplaces déclarés par l'outil quand il en a).
    const reinstall: Record<string, string[]> = {};
    for (const r of p.reinstall) {
      const dir = `${root}/${r.endsWith("/") ? r.slice(0, -1) : r}`;
      reinstall[r] = (await list(dir)).filter((n) => !n.startsWith(".")).sort(byCodePoint);
    }
    const info: Record<string, JSONValue> = {
      profile: p.id,
      profile_version: p.version,
      home,
      root,
      categories,
      reinstall,
      running,
    };
    const declared = await declaredPlugins(p, home);
    if (declared !== null) info.plugins = declared;
    await writeFile(path.join(meta, "profile.json"), prettyJSON(info));
    parts.push({ kind: "ai", target: `ai/${p.id}/meta`, source: meta, excludes: [], filesFrom: null });
  }
  return parts;
}
