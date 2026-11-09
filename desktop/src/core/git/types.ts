// Types de la maintenance git (port de `GoneBranch`, `WorktreeInfo`, `RepoReport`, `GitOptions`, GitMaintenance.swift).
// Données simples (pas de classes) : elles passent telles quelles d'un worker_thread au main, puis par l'IPC.
import type { CairnConfig } from "../config.ts";

export type BranchStatus = "merged" | "squash" | "unmerged";
export type WorktreeStatus = "orphan" | "merged" | "stale" | "risk" | "active";

export interface GoneBranch {
  repo: string;
  name: string;
  status: BranchStatus;
  /** SHA court vu à l'analyse (`%(objectname:short)`). */
  sha: string;
  /** Date du dernier commit (`%(committerdate:short)`). */
  date: string;
  subject: string;
  /** Extraite dans ce worktree : jamais proposée seule. */
  checkedOutInWorktree: string | null;
}

export interface WorktreeInfo {
  repo: string;
  path: string;
  branch: string | null;
  head: string;
  /** Dossier présent et worktree non `prunable`. */
  exists: boolean;
  size: number;
  regenerable: number;
  lastModified: Date | null;
  modifiedFiles: number;
  untrackedFiles: number;
  unpushedCommits: number;
  status: WorktreeStatus;
  /** Raison d'obsolescence quand le worktree est aussi « à risque ». */
  staleReason: WorktreeStatus | null;
  /** Fusion de sa branche dans la principale (`null` sans branche, ou si c'est la principale). */
  branchStatus: BranchStatus | null;
}

export interface RepoReport {
  path: string;
  gitBytes: number;
  looseBytes: number;
  mainRef: string | null;
  branches: GoneBranch[];
  worktrees: WorktreeInfo[];
  /** Espace libéré estimé par la suppression des branches proposées. */
  reclaimableBytes: number;
  /** Dernière activité : commit le plus récent (toutes refs) ou fichier le plus récent. */
  lastModified: Date | null;
  /** Lignes de `status --porcelain` du dossier principal. */
  modifiedFiles: number;
  /** `rev-list --count --branches --not --remotes`. */
  unpushedCommits: number;
}

export interface GitOptions {
  fetch: boolean;
  includeUnmerged: boolean;
  pruneNow: boolean;
  gc: boolean;
  staleDays: number;
  only: string | null;
  worktreesOnly: boolean;
  includeAtRisk: boolean;
}

export function defaultGitOptions(overrides: Partial<GitOptions> = {}): GitOptions {
  return {
    fetch: false,
    includeUnmerged: false,
    pruneNow: false,
    gc: true,
    staleDays: 30,
    only: null,
    worktreesOnly: false,
    includeAtRisk: false,
    ...overrides,
  };
}

/**
 * Options d'une analyse lancée depuis l'app : réglages `[git]` appliqués à ceux de l'écran Git. Pour « Tout vérifier »
 * (`fullCheck`), tous les dépôts et jamais de `git fetch` (`--prune` supprime des refs distantes) : 85501aa.
 */
export function forAnalysis(options: GitOptions, config: CairnConfig | null, fullCheck: boolean): GitOptions {
  return {
    ...options,
    staleDays: config?.git.worktreeStaleDays ?? 30,
    fetch: fullCheck ? false : (config?.git.fetchBefore ?? false),
    only: fullCheck ? null : options.only,
  };
}

export function branchId(b: GoneBranch): string {
  return `${b.repo}#${b.name}`;
}

export function worktreeId(w: WorktreeInfo): string {
  return w.path;
}

export function worktreeIsAtRisk(w: WorktreeInfo): boolean {
  return w.modifiedFiles > 0 || w.untrackedFiles > 0 || w.unpushedCommits > 0;
}

export function worktreeIsObsolete(w: WorktreeInfo): boolean {
  return w.status === "orphan" || w.status === "merged" || w.status === "stale" || w.staleReason !== null;
}

export function repoIsAtRisk(r: RepoReport): boolean {
  return r.modifiedFiles > 0 || r.unpushedCommits > 0;
}

/**
 * Classement d'un dossier (`Scanner.classify`) : `"source"` ou une catégorie régénérable / corbeille. Injecté pour
 * que la découverte et `lastModified` suivent les mêmes règles que l'analyse du disque (StorageWarningTests).
 */
export type Classify = (name: string, parentPath: string) => string | Promise<string>;

/** Taille d'un dossier et sa part régénérable (`Scanner.measure`), sans arbre en mémoire. */
export type Measure = (path: string) => Promise<{ size: number; regenerable: number }>;

export interface ScannerDeps {
  classify: Classify;
  measure: Measure;
}
