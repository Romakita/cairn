// Nettoyage git (port de `GitMaintenance.apply` et de l'application de `cairn git`). Worktrees d'abord, puis
// branches ; le journal est écrit avant chaque suppression ; une branche qui a bougé depuis l'analyse est gardée
// (46a9475). Le compactage (`gc`, `pruneNow`) ne tourne QUE sur les dépôts réellement nettoyés (design.md
// décision 12 : la 0.8.0 lançait `git gc` sur tous les dépôts analysés). Tout passe sous le verrou `git-clean`,
// partagé avec la sauvegarde : gc et prune ne doivent pas réécrire un `.git` en cours de copie.
import path from "node:path";
import { formatLocalDate } from "../dates.ts";
import { appendFile } from "../fs-promises.ts";
import { type StatePaths, withOperationLock } from "../lock.ts";
import { Git } from "./git.ts";
import type { RepoPlan } from "./selection.ts";
import { type GitOptions, type WorktreeInfo, worktreeIsAtRisk } from "./types.ts";

export const DELETION_LOG = "cleanup-deleted-branches.log";

export interface ApplyResult {
  deletedBranches: string[];
  removedWorktrees: string[];
  failures: string[];
}

/** Ligne `yyyy-MM-dd HH:mm:ss<TAB>champs…` (heure locale) ajoutée à `<git-dir>/cleanup-deleted-branches.log`. */
async function logDeletion(git: Git, fields: readonly string[], now: Date = new Date()): Promise<void> {
  const gitDir = await git.line(["rev-parse", "--absolute-git-dir"]);
  if (gitDir === null) return;
  const line = `${[formatLocalDate(now, "yyyy-MM-dd HH:mm:ss"), ...fields].join("\t")}\n`;
  await appendFile(path.join(gitDir, DELETION_LOG), line, "utf8").catch(() => {});
}

/**
 * Compactage d'un dépôt : avec `pruneNow`, expiration du reflog puis `gc --prune=now` (ou `prune --expire=now` si gc
 * est désactivé) ; sinon `gc --quiet` si gc est activé. À appeler sous le verrou `git-clean`.
 */
export async function compactRepo(repo: string, options: Pick<GitOptions, "gc" | "pruneNow">): Promise<void> {
  const git = new Git(repo);
  if (options.pruneNow) {
    await git.run(["reflog", "expire", "--expire-unreachable=now", "--all"]);
    // Sans gc, les objets devenus inaccessibles resteraient sur le disque : on les élague quand même.
    if (options.gc) await git.run(["gc", "--quiet", "--prune=now"]);
    else await git.run(["prune", "--expire=now"]);
  } else if (options.gc) {
    await git.run(["gc", "--quiet"]);
  }
}

/**
 * Supprime les worktrees puis les branches d'un dépôt, sans prendre le verrou (voir `applyCleanup`).
 * `expectedSHAs` : branche → SHA vu à l'analyse (court ou complet) ; une branche qui a bougé n'est pas supprimée et
 * compte comme un échec. Compacte le dépôt seulement si au moins un élément a été supprimé.
 */
export async function applyRepo(
  repo: string,
  branches: readonly string[],
  worktrees: readonly WorktreeInfo[],
  options: GitOptions,
  expectedSHAs: Readonly<Record<string, string>> = {},
): Promise<ApplyResult> {
  const git = new Git(repo);
  const result: ApplyResult = { deletedBranches: [], removedWorktrees: [], failures: [] };
  for (const w of worktrees) {
    await logDeletion(git, ["worktree", w.path, w.branch ?? "-", w.head]);
    if (w.exists) {
      const args = ["worktree", "remove", ...(worktreeIsAtRisk(w) ? ["--force", "--force"] : []), w.path];
      if (await git.ok(args)) result.removedWorktrees.push(w.path);
      else result.failures.push(w.path);
    } else {
      result.removedWorktrees.push(w.path); // orphelin : seulement retiré de l'index par `worktree prune`
    }
  }
  if (worktrees.length > 0) await git.run(["worktree", "prune"]);
  for (const b of branches) {
    const sha = await git.line(["rev-parse", `refs/heads/${b}`]);
    if (sha === null) continue;
    const expected = Object.hasOwn(expectedSHAs, b) ? expectedSHAs[b] : undefined;
    if (expected && !sha.startsWith(expected)) {
      result.failures.push(b);
      continue;
    }
    await logDeletion(git, [b, sha]);
    if (await git.ok(["branch", "-D", b])) result.deletedBranches.push(b);
    else result.failures.push(b);
  }
  if (result.deletedBranches.length + result.removedWorktrees.length > 0) await compactRepo(repo, options);
  return result;
}

export interface CleanupResult extends ApplyResult {
  /** Dépôts où quelque chose a été supprimé (donc compactés). */
  cleanedRepos: string[];
}

/**
 * Applique une sélection (`planFor`, ou celle de l'interface) sous le verrou `git-clean`. Un dépôt sans rien à
 * supprimer n'est pas touché (ni `worktree prune`, ni `gc`). Lève `OperationLockError` si une autre opération tient
 * le verrou.
 */
export function applyCleanup(
  paths: StatePaths,
  plans: readonly Pick<RepoPlan, "report" | "branches" | "worktrees">[],
  options: GitOptions,
): Promise<CleanupResult> {
  return withOperationLock(paths, "git-clean", async () => {
    const total: CleanupResult = { deletedBranches: [], removedWorktrees: [], failures: [], cleanedRepos: [] };
    for (const p of plans) {
      if (p.branches.length === 0 && p.worktrees.length === 0) continue;
      const expected: Record<string, string> = {};
      for (const b of p.branches) if (!Object.hasOwn(expected, b.name)) expected[b.name] = b.sha;
      const r = await applyRepo(
        p.report.path,
        p.branches.map((b) => b.name),
        p.worktrees,
        options,
        expected,
      );
      total.deletedBranches.push(...r.deletedBranches);
      total.removedWorktrees.push(...r.removedWorktrees);
      total.failures.push(...r.failures);
      if (r.deletedBranches.length + r.removedWorktrees.length > 0) total.cleanedRepos.push(p.report.path);
    }
    return total;
  });
}

/**
 * Options d'une suppression depuis l'app (menus des lignes, « Supprimer la sélection ») : jamais de gc ni d'élagage
 * immédiat, comme la 0.8.0. Le compactage reste une action à part ; les branches supprimées restent récupérables.
 */
export function appDeletionOptions(options: GitOptions): GitOptions {
  return { ...options, gc: false, pruneNow: false };
}

/** Compactage d'un seul dépôt depuis l'app (action « Compacter », confirmée), sous le verrou `git-clean`. */
export function compactUnderLock(
  paths: StatePaths,
  repo: string,
  options: Pick<GitOptions, "gc" | "pruneNow">,
): Promise<void> {
  return withOperationLock(paths, "git-clean", () => compactRepo(repo, options));
}
