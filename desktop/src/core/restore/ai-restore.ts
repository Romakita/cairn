// Restauration des données IA (port d'`AIRestore`, AIRestore.swift) : fusion fichier par fichier (la version la plus
// récente gagne, l'autre est gardée en `.pre-restore`), bases SQLite restaurées si elles manquent et remplacées
// seulement sur demande (`--replace-databases`, 01538a8), dossiers de projets de Claude Code renommés vers les nouveaux
// chemins. `meta/` n'est jamais fusionné.
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AIProfile, rootPath } from "../ai/profiles.ts";
import { describeError } from "../backup/types.ts";
import { t } from "../l10n.ts";

export interface AIRestoreReport {
  added: number;
  replacedOlder: number;
  keptNewer: number;
  databases: number;
  renamedProjects: string[];
  /** Données qui gardent les anciens chemins (non réécrites), à signaler à l'utilisateur. */
  notRewritten: string[];
}

export function emptyReport(): AIRestoreReport {
  return { added: 0, replacedOlder: 0, keptNewer: 0, databases: 0, renamedProjects: [], notRewritten: [] };
}

/** Ancien préfixe → nouveau préfixe (home d'origine → home, dossier d'origine → cible). */
export type PathPrefix = readonly [from: string, to: string];

export const PRE_RESTORE = ".pre-restore";

async function existsNoFollow(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryFollowing(p: string): Promise<boolean | null> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return null;
  }
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Fichiers (chemins relatifs) sous `dir`, comme l'énumérateur de `FileManager` : les liens symboliques ne sont pas
 * suivis, un lien vers un dossier n'est pas un fichier, un lien cassé est ignoré. Ordre stable (tri par nom).
 */
async function filesUnder(dir: string, rel = ""): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(path.join(dir, rel))).sort(byCodePoint);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const r = rel === "" ? n : `${rel}/${n}`;
    const full = path.join(dir, r);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...(await filesUnder(dir, r)));
    } else if (st.isSymbolicLink()) {
      if ((await isDirectoryFollowing(full)) === false) out.push(r);
    } else {
      out.push(r);
    }
  }
  return out;
}

/** Copie comme `FileManager.copyItem` : contenu, droits et dates gardés ; un lien symbolique est recréé tel quel. */
async function copyItem(from: string, to: string): Promise<void> {
  const st = await lstat(from);
  if (st.isSymbolicLink()) {
    await symlink(await readlink(from), to);
    return;
  }
  await copyFile(from, to);
  await utimes(to, st.atime, st.mtime);
}

/** Fusionne `src` dans `dest` (fichier par fichier). Une erreur d'écriture est relancée : la fusion s'arrête. */
export async function merge(src: string, dest: string, report: AIRestoreReport): Promise<void> {
  for (const rel of await filesUnder(src)) {
    const s = path.join(src, rel);
    const d = path.join(dest, rel);
    await mkdir(path.dirname(d), { recursive: true });
    if (!(await existsNoFollow(d))) {
      await copyItem(s, d);
      report.added += 1;
      continue;
    }
    const sa = await lstat(s);
    const da = await lstat(d);
    if (sa.size === da.size && Math.abs(sa.mtimeMs - da.mtimeMs) < 1000) continue;
    const pre = d + PRE_RESTORE;
    await rm(pre, { recursive: true, force: true });
    if (sa.mtimeMs > da.mtimeMs) {
      await rename(d, pre); // la version locale, plus ancienne, est gardée à côté
      await copyItem(s, d);
      report.replacedOlder += 1;
    } else {
      await copyItem(s, pre); // la locale est plus récente : la sauvegardée est écrite à côté
      report.keptNewer += 1;
    }
  }
}

/** Remplace une base locale par son snapshot : l'ancienne en `.pre-restore`, son WAL en `.pre-restore-wal`/`-shm`. */
export async function replaceDatabase(snapshot: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const existed = await existsNoFollow(dest);
  if (existed) {
    const pre = dest + PRE_RESTORE;
    await rm(pre, { recursive: true, force: true });
    await rename(dest, pre);
  }
  // Le journal WAL de l'ancienne base part avec elle (transactions pas encore écrites dans la base).
  for (const suffix of ["-wal", "-shm"]) {
    if (!(await existsNoFollow(dest + suffix))) continue;
    const pre = `${dest}${PRE_RESTORE}${suffix}`;
    try {
      await rm(pre, { force: true });
      if (existed) await rename(dest + suffix, pre);
      else await rm(dest + suffix, { force: true });
    } catch {
      // comme `try?` : un journal impossible à déplacer n'empêche pas la restauration
    }
  }
  await copyItem(snapshot, dest);
}

/** Base absente localement : toujours restaurée ; présente : remplacée seulement si `replace`. Vrai si écrite. */
export async function restoreDatabase(snapshot: string, dest: string, replace: boolean): Promise<boolean> {
  if (!replace && (await existsNoFollow(dest))) return false;
  await replaceDatabase(snapshot, dest);
  return true;
}

/** Nom de dossier de projet de Claude Code pour un chemin : tout caractère non alphanumérique devient `-`. */
export function claudeProjectName(p: string): string {
  return p.replace(/[^A-Za-z0-9]/gu, "-");
}

const charCount = (s: string) => [...s].length;

/**
 * Renomme les dossiers de `~/.claude/projects` selon les préfixes, le plus long d'abord (un dossier suivi sous l'ancien
 * home garde sa propre cible). Si le dossier cible existe, fusion puis suppression de l'ancien **seulement si la fusion
 * a réussi** ; sinon l'ancien reste en place et c'est signalé (01538a8).
 */
export async function rewriteClaudeProjects(
  projects: string,
  prefixes: readonly PathPrefix[],
  report: AIRestoreReport,
): Promise<void> {
  const ordered = prefixes.filter(([a, b]) => a !== b).sort((x, y) => charCount(y[0]) - charCount(x[0]));
  let names: string[];
  try {
    names = (await readdir(projects)).sort(byCodePoint);
  } catch {
    return;
  }
  for (const name of names) {
    for (const [old, next] of ordered) {
      const o = claudeProjectName(old);
      const n = claudeProjectName(next);
      if (!(name === o || name.startsWith(`${o}-`))) continue;
      const renamed = n + name.slice(o.length);
      const from = path.join(projects, name);
      const to = path.join(projects, renamed);
      try {
        if (await existsNoFollow(to)) {
          await merge(from, to, emptyReport());
          // Supprimé seulement après une fusion complète : rien n'est perdu si elle échoue en route.
          await rm(from, { recursive: true, force: true });
        } else {
          await rename(from, to);
        }
        report.renamedProjects.push(renamed);
      } catch (error) {
        report.notRewritten.push(t("ai.restore.rename_failed", name, describeError(error)));
      }
      break;
    }
  }
}

/** Données qui contiennent des chemins absolus que Cairn ne réécrit pas, quand un préfixe a changé. */
export async function notRewritten(tool: string, home: string, prefixes: readonly PathPrefix[]): Promise<string[]> {
  const changed = prefixes.filter(([a, b]) => a !== b);
  if (changed.length === 0) return [];
  switch (tool) {
    case "claude-code": {
      const out = [t("ai.restore.not_rewritten.claude_sessions")];
      let text: string | null = null;
      try {
        text = await readFile(path.join(home, ".claude.json"), "utf8");
      } catch {
        text = null;
      }
      if (text !== null && changed.some(([old]) => text.includes(`"${old}`))) {
        out.push(t("ai.restore.not_rewritten.claude_json"));
      }
      return out;
    }
    case "codex":
      return [t("ai.restore.not_rewritten.codex")];
    case "claude-desktop":
      return [t("ai.restore.not_rewritten.claude_desktop")];
    default:
      return [];
  }
}

export interface AIRestoreOptions {
  home: string;
  replaceDatabases: boolean;
  prefixes?: readonly PathPrefix[];
}

/** Restaure un outil depuis une version Cairn (`<version>/ai/<outil>`) : catégories fusionnées, puis bases. */
export async function restoreTool(
  toolDir: string,
  profile: AIProfile,
  options: AIRestoreOptions,
): Promise<AIRestoreReport> {
  const report = emptyReport();
  const prefixes = options.prefixes ?? [];
  const root = rootPath(profile, options.home);
  for (const cat of Object.keys(profile.categories).sort(byCodePoint)) {
    const dir = path.join(toolDir, cat);
    if (await existsNoFollow(dir)) await merge(dir, root, report);
  }
  const sqlite = path.join(toolDir, "meta/sqlite");
  let cats: string[];
  try {
    cats = (await readdir(sqlite)).sort(byCodePoint);
  } catch {
    cats = [];
  }
  for (const cat of cats) {
    const catDir = path.join(sqlite, cat);
    for (const rel of await filesUnder(catDir)) {
      if (await restoreDatabase(path.join(catDir, rel), path.join(root, rel), options.replaceDatabases)) {
        report.databases += 1;
      }
    }
  }
  if (profile.id === "claude-code") await rewriteClaudeProjects(path.join(root, ".claude/projects"), prefixes, report);
  report.notRewritten.push(...(await notRewritten(profile.id, options.home, prefixes)));
  return report;
}

/**
 * Restaure les données IA d'une sauvegarde de scripts/backup.sh : `home/.claude`, `home/.claude.json`, `home/.codex`,
 * `ai/sqlite/.codex|.claude/…`, `ai/claude-desktop/Claude`.
 */
export async function restoreLegacy(
  backup: string,
  tools: ReadonlySet<string>,
  options: AIRestoreOptions,
): Promise<AIRestoreReport> {
  const report = emptyReport();
  const { home } = options;
  const prefixes = options.prefixes ?? [];
  if (tools.has("claude-code")) {
    const src = path.join(backup, "home/.claude");
    if (await existsNoFollow(src)) await merge(src, path.join(home, ".claude"), report);
    const json = path.join(backup, "home/.claude.json");
    if (await existsNoFollow(json)) {
      // Fusion d'un seul fichier : passé par un dossier temporaire (même règle que les autres fichiers).
      const tmp = await mkdtemp(path.join(os.tmpdir(), "cairn-legacy-"));
      try {
        await copyItem(json, path.join(tmp, ".claude.json"));
        await merge(tmp, home, report);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    await rewriteClaudeProjects(path.join(home, ".claude/projects"), prefixes, report);
  }
  if (tools.has("codex")) {
    const src = path.join(backup, "home/.codex");
    if (await existsNoFollow(src)) await merge(src, path.join(home, ".codex"), report);
  }
  const sqlite = path.join(backup, "ai/sqlite");
  for (const rel of await filesUnder(sqlite)) {
    const tool = rel.startsWith(".codex/") ? "codex" : rel.startsWith(".claude/") ? "claude-code" : "";
    if (!tools.has(tool)) continue;
    if (await restoreDatabase(path.join(sqlite, rel), path.join(home, rel), options.replaceDatabases)) {
      report.databases += 1;
    }
  }
  if (tools.has("claude-desktop")) {
    const src = path.join(backup, "ai/claude-desktop/Claude");
    if (await existsNoFollow(src)) await merge(src, path.join(home, "Library/Application Support/Claude"), report);
  }
  for (const tool of [...tools].sort(byCodePoint))
    report.notRewritten.push(...(await notRewritten(tool, home, prefixes)));
  return report;
}
