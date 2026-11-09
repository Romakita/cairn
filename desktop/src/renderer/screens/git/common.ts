// Outils de l'écran Git : dates courtes, chemins, statuts et raisons d'indisponibilité des suppressions.
import type { BranchStatus, GoneBranch, WorktreeInfo, WorktreeStatus } from "../../../core/git/types.ts";
import { currentLanguage, t } from "../../../core/l10n.ts";
import type { GitView, RepoReport } from "../../../shared/contract.ts";
import type { Tone } from "../../ui/Banner.tsx";

export function shortDate(value: Date | string | number | null): string {
  if (value === null) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(currentLanguage(), { dateStyle: "medium" }).format(d);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export const branchTone: Record<BranchStatus, Tone> = { merged: "success", squash: "success", unmerged: "warning" };

export function worktreeTone(w: WorktreeInfo): Tone {
  if (atRisk(w)) return "warning";
  const tones: Record<WorktreeStatus, Tone> = {
    risk: "warning",
    active: "info",
    orphan: "neutral",
    merged: "success",
    stale: "success",
  };
  return tones[w.status];
}

/** Libellé de badge : majuscule initiale, comme tous les badges. */
export function badge(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

export function atRisk(w: WorktreeInfo): boolean {
  return w.modifiedFiles > 0 || w.untrackedFiles > 0 || w.unpushedCommits > 0;
}

export function repoAtRisk(r: RepoReport): boolean {
  return r.modifiedFiles > 0 || r.unpushedCommits > 0;
}

export function obsolete(w: WorktreeInfo): boolean {
  return w.status === "orphan" || w.status === "merged" || w.status === "stale" || w.staleReason !== null;
}

/** Raison pour laquelle on ne peut rien supprimer dans ce dépôt maintenant, `undefined` sinon. */
export function deletionBlocked(git: GitView, busyRepo: string | null, repo: string): string | undefined {
  if (git.running) return t("git.action.wait_analysis");
  if (git.applying || busyRepo === repo) return t("git.action.busy");
  return undefined;
}

export function branchBlocked(git: GitView, busyRepo: string | null, b: GoneBranch): string | undefined {
  return deletionBlocked(git, busyRepo, b.repo) ?? (b.checkedOutInWorktree ? t("git.action.in_worktree") : undefined);
}
