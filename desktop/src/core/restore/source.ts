// Sauvegarde à restaurer (port de `RestoreSource`, Restore.swift) : version Cairn (`manifest.json`) ou sauvegarde
// héritée de scripts/backup.sh (`manifest/system.txt` + `home/`, `workspaces/`, `ai/`). Versions de toutes les machines
// d'une destination montée et version proposée par défaut (46a9475 : la plus récente, ce Mac d'abord).
// Lecture seule : rien n'est écrit, ni sur la destination ni ailleurs.
import os from "node:os";
import path from "node:path";
import { isPartial, listVersions, MANIFEST_FILE, versionsDir } from "../backup/versions.ts";
import { parseISODate } from "../dates.ts";
import { readdir, readFile, stat } from "../fs-promises.ts";

export type RestoreSourceKind = "cairn" | "legacy";

/** Dossier suivi présent dans la sauvegarde : nom, emplacement d'origine et dossier dans la sauvegarde. */
export interface RestoreFolder {
  name: string;
  originalPath: string;
  dir: string;
}

export interface RestoreSource {
  kind: RestoreSourceKind;
  root: string;
  date: Date | null;
  machine: string;
  arch: string;
  folders: RestoreFolder[];
  /** Dossier `home/` de la sauvegarde (null si elle n'en a pas). */
  home: string | null;
  /** Outils IA présents (identifiants triés pour une version Cairn). */
  aiTools: string[];
  /** Dossier de l'inventaire (`tools/` avec tools.toml, ou `manifest/` hérité). */
  toolsDir: string | null;
  /** Home de la machine d'origine (`source` de la partie `home`, ou `home=` hérité). */
  originalHome: string | null;
}

/** Architecture de cette machine, comme `uname -m` (même valeur que le champ `arch` du manifest). */
export function currentArch(): string {
  return os.machine();
}

/** Architecture inconnue ou identique à celle de cette machine (sinon : avertissement avant la restauration). */
export function archMatches(source: Pick<RestoreSource, "arch">, current: string = currentArch()): boolean {
  return source.arch === "" || source.arch === current;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** `parts` comme `as? [[String: String]] ?? []` : une seule partie mal formée et la liste est vide. */
function stringParts(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, string>> = [];
  for (const p of value) {
    if (p === null || typeof p !== "object" || Array.isArray(p)) return [];
    const entries = Object.entries(p as Record<string, unknown>);
    if (!entries.every(([, v]) => typeof v === "string")) return [];
    out.push(Object.fromEntries(entries) as Record<string, string>);
  }
  return out;
}

const segments = (p: string) => p.split("/").filter((s) => s !== "");
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function openCairn(dir: string, m: Record<string, unknown>): Promise<RestoreSource> {
  const parts = stringParts(m.parts);
  const folders: RestoreFolder[] = [];
  for (const p of parts) {
    if (p.kind !== "folder" || p.target === undefined || p.source === undefined) continue;
    folders.push({ name: path.basename(p.target), originalPath: p.source, dir: path.join(dir, p.target) });
  }
  const ai = new Set<string>();
  for (const p of parts) {
    if (p.kind !== "ai" || p.target === undefined) continue;
    const id = segments(p.target)[1];
    if (id !== undefined) ai.add(id);
  }
  const home = parts.find((p) => p.kind === "home");
  const tools = path.join(dir, "tools");
  return {
    kind: "cairn",
    root: dir,
    date: typeof m.date === "string" ? parseISODate(m.date) : null,
    machine: typeof m.machine === "string" ? m.machine : "",
    arch: typeof m.arch === "string" ? m.arch : "",
    folders,
    home: home ? path.join(dir, "home") : null,
    aiTools: [...ai].sort(byCodePoint),
    toolsDir: (await exists(tools)) ? tools : null,
    originalHome: home?.source ?? null,
  };
}

/** Date `yyyy-MM-dd HH:mm:ss` (heure locale) de `manifest/system.txt`. */
function parseLegacyDate(text: string | undefined): Date | null {
  const m = text === undefined ? null : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, s);
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

async function openLegacy(dir: string, text: string): Promise<RestoreSource> {
  const info: Record<string, string> = {};
  for (const line of text.split("\n")) {
    // Comme `split(separator: "=", maxSplits: 1)` (morceaux vides omis) : clé et valeur non vides.
    const eq = line.indexOf("=");
    if (eq <= 0 || eq === line.length - 1) continue;
    info[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const ai: string[] = [];
  if (await exists(path.join(dir, "home/.claude"))) ai.push("claude-code");
  if (await exists(path.join(dir, "ai/claude-desktop"))) ai.push("claude-desktop");
  if (await exists(path.join(dir, "home/.codex"))) ai.push("codex");
  const ws = path.join(dir, "workspaces");
  const home = path.join(dir, "home");
  return {
    kind: "legacy",
    root: dir,
    date: parseLegacyDate(info.date),
    machine: info.host ?? "",
    arch: info.arch ?? "",
    folders: (await exists(ws))
      ? [{ name: "workspaces", originalPath: info.workspace ?? "/Volumes/workspaces", dir: ws }]
      : [],
    home: (await exists(home)) ? home : null,
    aiTools: ai,
    toolsDir: path.join(dir, "manifest"),
    originalHome: info.home ?? null,
  };
}

/** Reconnaît une version Cairn (`manifest.json`) ou une sauvegarde héritée ; `null` sinon. */
export async function openRestoreSource(dir: string): Promise<RestoreSource | null> {
  const manifest = await readText(path.join(dir, MANIFEST_FILE));
  if (manifest !== null) {
    try {
      const m: unknown = JSON.parse(manifest);
      if (m !== null && typeof m === "object" && !Array.isArray(m)) return openCairn(dir, m as Record<string, unknown>);
    } catch {
      // manifest illisible : peut-être une sauvegarde héritée
    }
  }
  const system = await readText(path.join(dir, "manifest/system.txt"));
  return system === null ? null : openLegacy(dir, system);
}

/** Version d'une destination montée. */
export interface RestoreVersion {
  machine: string;
  version: string;
  path: string;
  partial: boolean;
}

/** Versions terminées de toutes les machines (`cairn/<machine>/versions/*`), triées par machine puis par nom. */
export async function versionsOnDestination(root: string): Promise<RestoreVersion[]> {
  let machines: string[];
  try {
    machines = (await readdir(path.join(root, "cairn"))).sort(byCodePoint);
  } catch {
    machines = [];
  }
  const out: RestoreVersion[] = [];
  for (const machine of machines) {
    if (machine.startsWith(".")) continue;
    const dir = versionsDir(root, machine);
    for (const version of await listVersions(dir)) {
      const p = path.join(dir, version);
      out.push({ machine, version, path: p, partial: await isPartial(p) });
    }
  }
  return out;
}

/** La plus récente par nom (horodatage triable), pas la dernière de la liste, triée par machine (46a9475). */
function newest(list: readonly RestoreVersion[]): RestoreVersion | undefined {
  let best: RestoreVersion | undefined;
  for (const v of list) if (best === undefined || v.version > best.version) best = v;
  return best;
}

/**
 * Version proposée par défaut : la plus récente version complète de ce Mac, sinon la plus récente complète de toutes
 * les machines, sinon la plus récente (partielle). `null` sans aucune version.
 */
export function defaultVersion(all: readonly RestoreVersion[], machine: string): string | null {
  const complete = all.filter((v) => !v.partial);
  return (newest(complete.filter((v) => v.machine === machine)) ?? newest(complete) ?? newest(all))?.path ?? null;
}

/** Version demandée par son nom : celle de ce Mac d'abord (deux machines peuvent avoir le même nom de version). */
export function versionNamed(name: string, all: readonly RestoreVersion[], machine: string): string | null {
  return (
    (all.find((v) => v.version === name && v.machine === machine) ?? all.find((v) => v.version === name))?.path ?? null
  );
}

export type VersionChoice = { path: string } | { error: "unknownVersion" | "noVersion" };

/**
 * Choix de la version à restaurer : `requested` absente → `unknownVersion` (erreur d'usage, jamais de repli sur une
 * autre version) ; aucune version → `noVersion`.
 */
export function chooseVersion(
  all: readonly RestoreVersion[],
  machine: string,
  requested?: string | null,
): VersionChoice {
  if (requested !== undefined && requested !== null) {
    const p = versionNamed(requested, all, machine);
    return p === null ? { error: "unknownVersion" } : { path: p };
  }
  const p = defaultVersion(all, machine);
  return p === null ? { error: "noVersion" } : { path: p };
}
