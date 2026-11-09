// Exploitation d'une analyse (port d'Analysis.swift et d'`AnalysisSummary` de StorageAlerts.swift) : gros objets,
// projets et worktrees, présélection du nettoyage, résumé persistant `state/analysis-summary.json`, suppression.
import path from "node:path";
import { isoDate, parseISODate } from "./dates.ts";
import { readFile, rename, rm, stat, writeFile } from "./fs-promises.ts";
import { compactJSON } from "./json.ts";
import type { CairnPaths } from "./paths.ts";
import { type Category, isRegenerable, REGENERABLE_CATEGORIES } from "./regenerable.ts";
import { type BigFile, bytes, detach, type Node, regenerableBytes, type ScanResult, walk } from "./scanner.ts";

/** Exécute `body` sur chaque élément, au plus `limit` à la fois ; résultats dans l'ordre des éléments. */
async function mapLimit<T, R>(items: readonly T[], limit: number, body: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await body(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Fichier ordinaire (liens suivis, comme `fileExists(isDirectory:)`). */
async function isFile(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

// MARK: Présélection du nettoyage

/**
 * Dossiers régénérables proposés quand on arrive d'une alerte : les plus gros (au plus `limit`, chacun d'au moins
 * `minBytes`). Une simple présélection : rien n'est supprimé sans confirmation.
 */
export function preselectCleanup(nodes: readonly Node[], limit = 10, minBytes = 100_000_000): Node[] {
  return nodes
    .filter((n) => n.isDirectory && isRegenerable(n.category) && n.size >= minBytes)
    .sort((a, b) => b.size - a.size)
    .slice(0, limit);
}

/** Dossiers régénérables de l'arbre, du plus gros au plus petit (écran « Nettoyable »). */
export function regenerableNodes(root: Node): Node[] {
  const out: Node[] = [];
  walk(root, (n) => {
    if (n.isDirectory && isRegenerable(n.category)) out.push(n);
  });
  return out.sort((a, b) => b.size - a.size);
}

// MARK: Gros objets

export interface BigObject {
  kind: "file" | "folder";
  path: string;
  size: number;
  category: Category;
}

/**
 * Gros fichiers, puis gros dossiers : dossiers de plus de `folderThreshold` sans compter les gros fichiers, au niveau
 * le plus précis (aucun de leurs sous-dossiers n'atteint le seuil à lui seul). La racine n'est jamais listée.
 */
export function findBigObjects(root: Node, bigFiles: readonly BigFile[], folderThreshold: number): BigObject[] {
  // Octets de gros fichiers sous chaque dossier.
  const bigUnder = new Map<string, number>();
  for (const f of bigFiles) {
    let dir = path.dirname(f.path);
    while (dir.length >= root.path.length) {
      bigUnder.set(dir, (bigUnder.get(dir) ?? 0) + f.size);
      if (dir === root.path) break;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  const folders: BigObject[] = [];
  /** Vrai si ce dossier ou l'un de ses descendants a été retenu. */
  const visit = (n: Node): boolean => {
    if (!n.isDirectory) return false;
    let descendantListed = false;
    for (const c of n.children) if (c.isDirectory && visit(c)) descendantListed = true;
    const without = n.size - (bigUnder.get(n.path) ?? 0);
    if (without < folderThreshold) return descendantListed;
    if (descendantListed) return true;
    if (n !== root) folders.push({ kind: "folder", path: n.path, size: without, category: n.category });
    return true;
  };
  visit(root);
  const files: BigObject[] = bigFiles.map((f) => ({ kind: "file", path: f.path, size: f.size, category: f.category }));
  return [...files, ...folders].sort((a, b) => b.size - a.size);
}

// MARK: Projets

export interface Worktree {
  path: string;
  size: number;
  repoPath: string;
}

export interface Project {
  path: string;
  name: string;
  isGitRepo: boolean;
  size: number;
  source: number;
  git: number;
  regenerable: number;
  worktrees: Worktree[];
}

export const PROJECT_MARKERS: readonly string[] = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "composer.json",
  "Package.swift",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "pubspec.yaml",
  "requirements.txt",
];

export function worktreeBytes(p: Project): number {
  return p.worktrees.reduce((sum, w) => sum + w.size, 0);
}

/** Taille totale, worktrees situés hors du dépôt compris. */
export function projectTotalSize(p: Project): number {
  return p.size + p.worktrees.filter((w) => !w.path.startsWith(`${p.path}/`)).reduce((sum, w) => sum + w.size, 0);
}

/** Dépôt d'un worktree d'après son fichier `.git` (« gitdir: <dépôt>/.git/worktrees/<nom> »), sinon `null`. */
export async function worktreeRepo(dir: string): Promise<string | null> {
  const gitFile = `${dir}/.git`;
  if (!(await isFile(gitFile))) return null;
  let text: string;
  try {
    text = await readFile(gitFile, "utf8");
  } catch {
    return null;
  }
  const line = text.split("\n").find((l) => l.startsWith("gitdir:"));
  if (!line) return null;
  let gitdir = line.slice("gitdir:".length).trim();
  if (!gitdir.startsWith("/")) gitdir = path.resolve(dir, gitdir);
  const i = gitdir.indexOf("/.git/worktrees/");
  return i < 0 ? null : gitdir.slice(0, i);
}

const CONCURRENCY = 64;

/**
 * Projets (dépôts git ou dossiers avec un fichier de projet) triés par taille, avec leurs worktrees rattachés (y compris
 * ceux créés dans le dépôt, `.claude/worktrees/…`). On ne descend pas dans un projet trouvé.
 */
export async function findProjects(root: Node, maxDepth = 5): Promise<Project[]> {
  // 1. Worktrees, niveau par niveau (lectures du fichier `.git` en parallèle).
  const worktrees = new Map<string, Worktree[]>();
  const worktreePaths = new Set<string>();
  let level: Node[] = [root];
  for (let depth = 0; level.length > 0 && depth <= maxDepth + 3; depth++) {
    const candidates = level.filter((n) => n.isDirectory && n.category === "source");
    const repos = await mapLimit(candidates, CONCURRENCY, (n) =>
      n === root ? Promise.resolve(null) : worktreeRepo(n.path),
    );
    const next: Node[] = [];
    for (const [i, n] of candidates.entries()) {
      const repo = repos[i];
      if (repo) {
        const list = worktrees.get(repo) ?? [];
        list.push({ path: n.path, size: n.size, repoPath: repo });
        worktrees.set(repo, list);
        worktreePaths.add(n.path);
      } else {
        next.push(...n.children);
      }
    }
    level = next;
  }

  // 2. Projets.
  const projects: Project[] = [];
  level = [root];
  for (let depth = 0; level.length > 0 && depth <= maxDepth; depth++) {
    const candidates = level.filter((n) => n.isDirectory && n.category === "source" && !worktreePaths.has(n.path));
    const marked = await mapLimit(candidates, CONCURRENCY, async (n) => {
      if (n.isGitRepo) return true;
      for (const m of PROJECT_MARKERS) if (await exists(`${n.path}/${m}`)) return true;
      return false;
    });
    const next: Node[] = [];
    for (const [i, n] of candidates.entries()) {
      if (marked[i] && n !== root) {
        projects.push({
          path: n.path,
          name: n.name,
          isGitRepo: n.isGitRepo,
          size: n.size,
          source: bytes(n, "source"),
          git: bytes(n, "git"),
          regenerable: regenerableBytes(n),
          worktrees: worktrees.get(n.path) ?? [],
        });
      } else {
        next.push(...n.children);
      }
    }
    level = next;
  }
  return projects.sort((a, b) => projectTotalSize(b) - projectTotalSize(a));
}

// MARK: Résumé persistant

/** Résumé de la dernière analyse (`state/analysis-summary.json`) : lu par la barre des menus et les alertes. */
export interface AnalysisSummary {
  date: Date;
  totalBytes: number;
  /** Clé : catégorie régénérable (`deps`, `build`, `ios`, `python`, `cache`). */
  reclaimableByType: Record<string, number>;
  obsoleteWorktreeBytes: number;
  trashBytes: number;
}

export function reclaimableBytes(s: AnalysisSummary): number {
  return Object.values(s.reclaimableByType).reduce((a, b) => a + b, 0) + s.obsoleteWorktreeBytes + s.trashBytes;
}

/** Résumé d'une analyse (régénérable et corbeille ; worktrees obsolètes fournis par la maintenance git). */
export function summaryFromRoots(
  roots: readonly Node[],
  obsoleteWorktreeBytes = 0,
  date = new Date(),
): AnalysisSummary {
  const byType: Record<string, number> = {};
  for (const c of REGENERABLE_CATEGORIES) byType[c] = roots.reduce((sum, r) => sum + bytes(r, c), 0);
  return {
    date,
    totalBytes: roots.reduce((sum, r) => sum + r.size, 0),
    reclaimableByType: byType,
    obsoleteWorktreeBytes,
    trashBytes: roots.reduce((sum, r) => sum + bytes(r, "trash"), 0),
  };
}

export function summaryFile(paths: CairnPaths): string {
  return path.join(paths.state, "analysis-summary.json");
}

/** Écriture atomique (fichier temporaire puis `rename`, comme `.atomic`). */
export async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Même JSON que la 0.8.0 : compact, clés triées, date ISO 8601 à la seconde. */
export function encodeSummary(s: AnalysisSummary): string {
  return compactJSON({
    date: isoDate(s.date),
    totalBytes: s.totalBytes,
    reclaimableByType: { ...s.reclaimableByType },
    obsoleteWorktreeBytes: s.obsoleteWorktreeBytes,
    trashBytes: s.trashBytes,
  });
}

export function decodeSummary(text: string): AnalysisSummary | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const date = typeof o.date === "string" ? parseISODate(o.date) : null;
  const byType = o.reclaimableByType;
  if (!date || typeof byType !== "object" || byType === null) return null;
  const reclaimable: Record<string, number> = {};
  for (const [k, v] of Object.entries(byType)) {
    if (typeof v !== "number") return null;
    reclaimable[k] = v;
  }
  for (const k of ["totalBytes", "obsoleteWorktreeBytes", "trashBytes"]) if (typeof o[k] !== "number") return null;
  return {
    date,
    totalBytes: o.totalBytes as number,
    reclaimableByType: reclaimable,
    obsoleteWorktreeBytes: o.obsoleteWorktreeBytes as number,
    trashBytes: o.trashBytes as number,
  };
}

export async function loadSummary(paths: CairnPaths): Promise<AnalysisSummary | null> {
  try {
    return decodeSummary(await readFile(summaryFile(paths), "utf8"));
  } catch {
    return null;
  }
}

export async function saveSummary(s: AnalysisSummary, paths: CairnPaths): Promise<void> {
  await paths.prepare(paths.state);
  await writeAtomic(summaryFile(paths), encodeSummary(s));
}

// MARK: Suppression

/** Mise à la corbeille, fournie par l'appelant (`shell.trashItem` côté Electron). */
export type Trasher = (file: string) => Promise<void>;

export interface RemovalFailure {
  path: string;
  message: string;
}

export interface RemovalResult {
  removed: Node[];
  failures: RemovalFailure[];
  /** Octets libérés (une fois la corbeille vidée, pour une mise à la corbeille). */
  freed: number;
}

/**
 * Met à la corbeille (par défaut) ou supprime définitivement les éléments choisis, APRÈS confirmation par l'appelant,
 * puis met à jour les totaux sans nouvelle analyse (`detach`) et retire les gros fichiers concernés de `result`.
 * Les gros objets et projets se recalculent ensuite avec `findBigObjects` et `findProjects`.
 */
export async function removeNodes(
  nodes: readonly Node[],
  options: { permanently: boolean; trash: Trasher; result?: ScanResult },
): Promise<RemovalResult> {
  const removed: Node[] = [];
  const failures: RemovalFailure[] = [];
  for (const node of nodes) {
    try {
      if (options.permanently) await rm(node.path, { recursive: true });
      else await options.trash(node.path);
      removed.push(node);
    } catch (error) {
      failures.push({ path: node.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const freed = removed.reduce((sum, n) => sum + n.size, 0);
  for (const n of removed) detach(n);
  if (options.result && removed.length > 0) {
    const gone = removed.map((n) => n.path);
    options.result.bigFiles = options.result.bigFiles.filter(
      (f) => !gone.some((p) => f.path === p || f.path.startsWith(`${p}/`)),
    );
  }
  return { removed, failures, freed };
}
