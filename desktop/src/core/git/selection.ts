// Présélection et récapitulatif (port de `selectedByDefault`, `branchesFollowing`, `preselection`, `recap`,
// `RepoReport.removing` et de la sélection de `cairn git`). Règles pures, sans git.
// Dans l'app, rien n'est présélectionné (delta git-row-actions) : ces règles servent à la CLI et au hub.
import {
  branchId,
  type GitOptions,
  type GoneBranch,
  type RepoReport,
  type WorktreeInfo,
  worktreeId,
  worktreeIsAtRisk,
  worktreeIsObsolete,
} from "./types.ts";

/** Branche proposée : fusionnée ou squashée (non fusionnée si demandé), jamais extraite dans un worktree. */
export function selectedBranchByDefault(b: GoneBranch, options: GitOptions): boolean {
  return b.checkedOutInWorktree === null && (b.status !== "unmerged" || options.includeUnmerged);
}

/** Worktree proposé : obsolète et sans travail en cours (ou « à risque » si demandé). */
export function selectedWorktreeByDefault(w: WorktreeInfo, options: GitOptions): boolean {
  return worktreeIsObsolete(w) && (!worktreeIsAtRisk(w) || options.includeAtRisk);
}

/** Branches à supprimer avec les worktrees choisis (chemins) : fusionnées ou squashées, extraites dans l'un d'eux. */
export function branchesFollowing(worktrees: ReadonlySet<string>, branches: readonly GoneBranch[]): GoneBranch[] {
  return branches.filter(
    (b) => b.status !== "unmerged" && b.checkedOutInWorktree !== null && worktrees.has(b.checkedOutInWorktree),
  );
}

/** Présélection (identifiants) : calculable dépôt par dépôt, au fil de l'analyse. */
export function preselection(
  reports: readonly RepoReport[],
  options: GitOptions,
): { branches: Set<string>; worktrees: Set<string> } {
  const worktrees = new Set(
    reports.flatMap((r) => r.worktrees.filter((w) => selectedWorktreeByDefault(w, options)).map(worktreeId)),
  );
  const all = reports.flatMap((r) => r.branches);
  const branches = new Set(all.filter((b) => selectedBranchByDefault(b, options)).map(branchId));
  for (const b of branchesFollowing(worktrees, all)) branches.add(branchId(b));
  return { branches, worktrees };
}

export interface RepoPlan {
  report: RepoReport;
  branches: GoneBranch[];
  worktrees: WorktreeInfo[];
}

/**
 * Sélection de `cairn git` pour un dépôt : worktrees proposés, branches proposées et branches intégrées de ces
 * worktrees ; aucune branche avec `--worktrees-only`.
 */
export function planFor(report: RepoReport, options: GitOptions): RepoPlan {
  const worktrees = report.worktrees.filter((w) => selectedWorktreeByDefault(w, options));
  const removed = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null));
  const branches = options.worktreesOnly
    ? []
    : report.branches.filter(
        (b) =>
          selectedBranchByDefault(b, options) ||
          (b.checkedOutInWorktree !== null && removed.has(b.name) && b.status !== "unmerged"),
      );
  return { report, branches, worktrees };
}

export interface Recap {
  gitBytes: number;
  deletedBranches: number;
  keptBranches: number;
  removedWorktrees: number;
  keptWorktrees: number;
}

/** Récapitulatif d'une sélection (identifiants) : taille des `.git`, branches et worktrees supprimés / gardés. */
export function recap(
  reports: readonly RepoReport[],
  branches: ReadonlySet<string>,
  worktrees: ReadonlySet<string>,
): Recap {
  const r: Recap = { gitBytes: 0, deletedBranches: 0, keptBranches: 0, removedWorktrees: 0, keptWorktrees: 0 };
  for (const rep of reports) {
    r.gitBytes += rep.gitBytes;
    const del = rep.branches.filter((b) => branches.has(branchId(b))).length;
    r.deletedBranches += del;
    r.keptBranches += rep.branches.length - del;
    const rm = rep.worktrees.filter((w) => worktrees.has(worktreeId(w))).length;
    r.removedWorktrees += rm;
    r.keptWorktrees += rep.worktrees.length - rm;
  }
  return r;
}

/**
 * Rapport après suppression de branches (noms) et de worktrees (chemins) : le reste de l'analyse est gardé, les
 * branches extraites dans un worktree supprimé redeviennent libres.
 */
export function removing(report: RepoReport, names: ReadonlySet<string>, paths: ReadonlySet<string>): RepoReport {
  return {
    ...report,
    worktrees: report.worktrees.filter((w) => !paths.has(w.path)),
    branches: report.branches
      .filter((b) => !names.has(b.name))
      .map((b) =>
        b.checkedOutInWorktree !== null && paths.has(b.checkedOutInWorktree) ? { ...b, checkedOutInWorktree: null } : b,
      ),
  };
}
