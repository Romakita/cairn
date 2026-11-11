// Maintenance git dans l'app : analyse dans le pool de workers (rapports au fil de l'eau), nettoyage d'une sélection
// confirmée par le main (verrou `git-clean`, compactage des seuls dépôts nettoyés), compactage et mise à la corbeille
// d'un dépôt. Les sélections désignent des éléments du dernier rapport, jamais des chemins libres.
import { shell } from "electron";
import { folderExpandedPath } from "../core/config.ts";
import { Fmt } from "../core/format.ts";
import { refreshSizes } from "../core/git/analysis.ts";
import { appDeletionOptions, applyCleanup, type CleanupResult, compactUnderLock } from "../core/git/apply.ts";
import { analyzeAll, type PoolProgress } from "../core/git/pool.ts";
import { type RepoPlan, removing } from "../core/git/selection.ts";
import { defaultGitOptions, forAnalysis, type GitOptions, type RepoReport } from "../core/git/types.ts";
import { t } from "../core/l10n.ts";
import { classify } from "../core/regenerable.ts";
import type { CompactResult, Confirmed, GitAnalyzeArgs, GitSelection, GitView } from "../shared/contract.ts";
import { itemList } from "./confirm.ts";
import { ApiError } from "./errors.ts";
import type { Host } from "./host.ts";

export class GitService {
  private reports: RepoReport[] = [];
  private failed: Record<string, string> = {};
  private progress: PoolProgress | null = null;
  private controller: AbortController | null = null;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private applying = false;
  private lastCleanup: CleanupResult | null = null;
  private error: string | null = null;
  private options: GitOptions = defaultGitOptions();
  /** Une analyse a déjà eu lieu (sinon la carte git de l'accueil reste « non analysé »). */
  analyzed = false;

  constructor(private readonly host: Host) {}

  get running(): boolean {
    return this.controller !== null;
  }

  private baseOptions(): GitOptions {
    const g = this.host.config().git;
    return defaultGitOptions({ gc: g.gc, fetch: g.fetchBefore, staleDays: g.worktreeStaleDays });
  }

  /** Analyse les dépôts des dossiers suivis ; `fullCheck` : tous les dépôts, jamais de `git fetch` (85501aa). */
  async analyze(args: GitAnalyzeArgs): Promise<void> {
    if (this.controller) throw new ApiError("busy", t("hub.checking"));
    const config = this.host.config();
    const folders = config.folders.map(folderExpandedPath);
    if (folders.length === 0) throw new ApiError("notFound", "no folder to analyze");
    const options = forAnalysis(
      {
        ...this.baseOptions(),
        only: args.only ?? null,
        includeUnmerged: args.includeUnmerged ?? false,
        worktreesOnly: args.worktreesOnly ?? false,
        includeAtRisk: args.includeAtRisk ?? false,
      },
      config,
      args.fullCheck ?? false,
    );
    const controller = new AbortController();
    this.controller = controller;
    this.options = options;
    this.reports = [];
    this.failed = {};
    this.error = null;
    this.startedAt = Date.now();
    this.host.changed();
    try {
      const result = await analyzeAll(folders, options, classify, {
        workerFile: this.host.gitWorkerFile,
        signal: controller.signal,
        progress: (p) => {
          this.progress = p;
          this.failed = p.failed;
          this.host.changed();
        },
        onReport: (r) => {
          this.reports.push(r);
          this.host.changed();
        },
      });
      // Ordre des dépôts (les rapports arrivent dans l'ordre de fin).
      this.reports = result.reports;
      this.failed = result.failed;
      this.analyzed = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.controller = null;
      this.progress = null;
      this.finishedAt = Date.now();
      this.host.changed();
    }
  }

  cancel(): void {
    this.controller?.abort();
  }

  private report(repo: string): RepoReport {
    const r = this.reports.find((x) => x.path === repo);
    if (!r) throw new ApiError("notFound", `unknown repository ${repo}`);
    return r;
  }

  /** Plans d'une sélection : chaque branche et worktree doit figurer dans le dernier rapport du dépôt. */
  private plans(selections: readonly GitSelection[]): RepoPlan[] {
    return selections.map((s) => {
      const report = this.report(s.repo);
      const branches = s.branches.map((name) => {
        const b = report.branches.find((x) => x.name === name);
        if (!b) throw new ApiError("notFound", `unknown branch ${name}`);
        return b;
      });
      const worktrees = s.worktrees.map((p) => {
        const w = report.worktrees.find((x) => x.path === p);
        if (!w) throw new ApiError("notFound", `unknown worktree ${p}`);
        return w;
      });
      return { report, branches, worktrees };
    });
  }

  /** Supprime la sélection après confirmation (verrou `git-clean`). */
  async apply(selections: readonly GitSelection[], confirmed = false): Promise<Confirmed<CleanupResult>> {
    if (this.controller || this.applying) throw new ApiError("busy", t("hub.checking"));
    const plans = this.plans(selections);
    const branches = plans.flatMap((p) => p.branches.map((b) => `${b.name} (${b.sha})`));
    const worktrees = plans.flatMap((p) => p.worktrees.map((w) => w.path));
    if (branches.length + worktrees.length === 0) return { cancelled: true };
    const ok =
      confirmed ||
      (await this.host.confirm({
        message: t("cli.git.confirm", branches.length, worktrees.length, ""),
        detail: [itemList([...worktrees, ...branches], 8), t("git.confirm.log")].join("\n\n"),
        confirm: t("git.apply"),
        destructive: true,
      }));
    if (!ok) return { cancelled: true };
    this.applying = true;
    this.host.changed();
    try {
      const result = await applyCleanup({ stateDir: this.host.paths.state }, plans, appDeletionOptions(this.options));
      const names = new Set(result.deletedBranches);
      const paths = new Set(result.removedWorktrees);
      this.reports = this.reports.map((r) => removing(r, names, paths));
      // Remesure des seuls dépôts nettoyés (worktrees retirés : taille et dossier .git changent).
      const cleaned = new Set(result.cleanedRepos);
      this.reports = await Promise.all(
        this.reports.map((r) => (cleaned.has(r.path) ? refreshSizes(r, this.options).catch(() => r) : r)),
      );
      this.lastCleanup = result;
      if (result.deletedBranches.length + result.removedWorktrees.length > 0) {
        this.host.logActivity({
          kind: "gitCleanup",
          count: result.deletedBranches.length + result.removedWorktrees.length,
        });
      }
      void this.host.checkStorage();
      return { cancelled: false, value: result };
    } finally {
      this.applying = false;
      this.host.changed();
    }
  }

  /**
   * Compacte un dépôt analysé (`git gc`, et `pruneNow` : objets inaccessibles élagués tout de suite), après
   * confirmation ; rend la taille du dossier `.git` avant et après, et met le rapport à jour.
   */
  async compact(repo: string, pruneNow = false, confirmed = false): Promise<Confirmed<CompactResult>> {
    const report = this.report(repo);
    const ok =
      confirmed ||
      (await this.host.confirm({
        message: t("git.compact.title", repo),
        detail: t("git.compact.detail", Fmt.bytes(report.gitBytes), Fmt.bytes(report.looseBytes)),
        confirm: t("git.compact.confirm"),
      }));
    if (!ok) return { cancelled: true };
    const measured = await refreshSizes(report, this.options).catch(() => report);
    await compactUnderLock({ stateDir: this.host.paths.state }, repo, { gc: true, pruneNow });
    const updated = await refreshSizes(measured, this.options).catch(() => measured);
    this.reports = this.reports.map((r) => (r.path === repo ? updated : r));
    const before = measured.gitBytes;
    const after = updated.gitBytes;
    void this.host.checkStorage();
    this.host.changed();
    return { cancelled: false, value: { repo, before, after } };
  }

  /** Met tout le dépôt à la corbeille (récupérable), après confirmation. */
  async trashRepo(repo: string, confirmed = false): Promise<Confirmed> {
    const report = this.report(repo);
    const risk =
      report.modifiedFiles > 0 || report.unpushedCommits > 0
        ? `\n\n${t("git.trash.risk", report.modifiedFiles, report.unpushedCommits)}`
        : "";
    const ok =
      confirmed ||
      (await this.host.confirm({
        message: t("git.trash.title", repo),
        detail: t("git.trash.detail", report.lastModified ? Fmt.date(report.lastModified) : "—") + risk,
        confirm: t("action.trash"),
        destructive: risk !== "",
      }));
    if (!ok) return { cancelled: true };
    await shell.trashItem(repo);
    this.reports = this.reports.filter((r) => r.path !== repo);
    this.host.message("success", t("git.trashed", repo));
    void this.host.checkStorage();
    this.host.changed();
    return { cancelled: false };
  }

  get lastReports(): readonly RepoReport[] {
    return this.reports;
  }

  get currentOptions(): GitOptions {
    return this.options;
  }

  view(): GitView {
    return {
      running: this.controller !== null,
      progress: this.progress,
      reports: this.reports,
      failed: this.failed,
      options: this.options,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      applying: this.applying,
      lastCleanup: this.lastCleanup,
      error: this.error,
    };
  }
}
