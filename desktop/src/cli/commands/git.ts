// `cairn git [options]` (port de `CLI.gitCommand`) : branches « gone » et worktrees obsolètes.
// SIMULATION par défaut : rien ne change sans `--apply`, qui demande confirmation (sauf `--yes`) et prend le verrou
// d'opération `git-clean` (partagé avec la sauvegarde). Seuls les dépôts où quelque chose est supprimé sont compactés
// (design.md, décision 12). La progression va sur stderr, seulement si c'est un terminal (🐞 ef55c5b).
import { folderExpandedPath } from "../../core/config.ts";
import { Fmt } from "../../core/format.ts";
import { writeFile } from "../../core/fs-promises.ts";
import { applyCleanup } from "../../core/git/apply.ts";
import { analyzeAll } from "../../core/git/pool.ts";
import { tsv } from "../../core/git/report-tsv.ts";
import { planFor, type RepoPlan } from "../../core/git/selection.ts";
import { defaultGitOptions, type GitOptions } from "../../core/git/types.ts";
import type { JSONValue } from "../../core/json.ts";
import { t } from "../../core/l10n.ts";
import { OperationLockError } from "../../core/lock.ts";
import { expandTilde } from "../../core/paths.ts";
import { classify } from "../../core/regenerable.ts";
import { confirm as askConfirmation } from "../prompt.ts";
import { type CommandEnv, Exit, type ExitCode, errorText, printJSON, readConfig, wantsHelp } from "../shared.ts";
import { DEFAULT_FOLDER } from "./analyze.ts";

/** Seuil des objets « en vrac » qui fait afficher un dépôt sans rien à supprimer (50 Mo). */
const LOOSE_BYTES_SHOWN = 50_000_000;

function planJSON(plans: readonly RepoPlan[]): JSONValue {
  return {
    repos: plans.map(({ report: r, branches, worktrees }) => ({
      path: r.path,
      git_bytes: r.gitBytes,
      loose_bytes: r.looseBytes,
      main: r.mainRef,
      reclaimable_bytes: r.reclaimableBytes,
      branches: r.branches.map((b) => ({
        name: b.name,
        status: b.status,
        sha: b.sha,
        date: b.date,
        subject: b.subject,
        selected: branches.includes(b),
        worktree: b.checkedOutInWorktree,
      })),
      worktrees: r.worktrees.map((w) => ({
        path: w.path,
        branch: w.branch,
        status: w.status,
        stale_reason: w.staleReason,
        size: w.size,
        modified: w.modifiedFiles,
        untracked: w.untrackedFiles,
        unpushed: w.unpushedCommits,
        selected: worktrees.includes(w),
      })),
    })),
  };
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

export async function git({ args, store, io, context }: CommandEnv): Promise<ExitCode> {
  if (wantsHelp(args)) {
    io.out(t("cli.git.help"));
    return Exit.ok;
  }
  const config = await readConfig(store);
  const o: GitOptions = defaultGitOptions({
    gc: config.git.gc,
    fetch: config.git.fetchBefore,
    staleDays: config.git.worktreeStaleDays,
  });
  let apply = false;
  let yes = false;
  let json = false;
  let roots: string[] = [];
  let reportPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string | null => {
      const v = args[i + 1];
      if (v === undefined) {
        io.err(t("cli.missing_value", a));
        return null;
      }
      i += 1;
      return v;
    };
    switch (a) {
      case "--apply":
        apply = true;
        break;
      case "--yes":
      case "-y":
        yes = true;
        break;
      case "--json":
        json = true;
        break;
      case "--fetch":
        o.fetch = true;
        break;
      case "--include-unmerged":
        o.includeUnmerged = true;
        break;
      case "--prune-now":
        o.pruneNow = true;
        break;
      case "--no-gc":
        o.gc = false;
        break;
      case "--worktrees-only":
        o.worktreesOnly = true;
        break;
      case "--include-at-risk":
        o.includeAtRisk = true;
        break;
      case "--only": {
        const v = value();
        if (v === null) return Exit.usage;
        o.only = v;
        break;
      }
      case "--root": {
        const v = value();
        if (v === null) return Exit.usage;
        roots.push(expandTilde(v));
        break;
      }
      case "--report": {
        const v = value();
        if (v === null) return Exit.usage;
        reportPath = expandTilde(v);
        break;
      }
      case "--stale-days": {
        const v = args[i + 1];
        const n = v !== undefined && /^[+-]?\d+$/.test(v) ? Number(v) : Number.NaN;
        if (!(n > 0)) {
          io.err(t("cli.missing_value", "--stale-days"));
          return Exit.usage;
        }
        i += 1;
        o.staleDays = n;
        break;
      }
      default:
        io.err(t("cli.unknown_option", a));
        return Exit.usage;
    }
  }
  if (roots.length === 0) roots = config.folders.map(folderExpandedPath);
  if (roots.length === 0) roots = [DEFAULT_FOLDER];

  const workerFile = context.gitWorkerFile;
  if (!workerFile) throw new Error("git worker file not configured (CliContext.gitWorkerFile)");
  const stderr = context.progress ?? process.stderr;
  const showProgress = !json && stderr.isTTY === true;
  const { reports } = await analyzeAll(roots, o, classify, {
    workerFile,
    progress: (p) => {
      if (!showProgress || p.total <= 0) return;
      const biggest = Math.max(0, ...Object.values(p.running));
      stderr.write(`${t("git.worker.progress", p.done, p.total, Object.keys(p.running).length, Fmt.bytes(biggest))}\r`);
    },
  });
  if (showProgress) stderr.write("\n");
  const root = roots.length === 1 ? roots[0]! : "";
  const rel = (p: string) => (root !== "" && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);

  // Sélection : branches et worktrees proposés par défaut.
  const plans = reports.map((r) => planFor(r, o));

  if (reportPath !== null) {
    try {
      await writeFile(reportPath, tsv(reports, root), "utf8");
    } catch (error) {
      io.err(errorText(error));
      return Exit.failure;
    }
  }

  const branchCount = sum(plans.map((p) => p.branches.length));
  const worktreeCount = sum(plans.map((p) => p.worktrees.length));
  if (json) {
    printJSON(planJSON(plans), io);
  } else {
    io.out(t(apply ? "cli.git.mode_apply" : "cli.git.mode_simulation", roots.join(", ")));
    for (const { report: r, branches, worktrees } of plans) {
      if (r.branches.length === 0 && r.worktrees.length === 0 && r.looseBytes <= LOOSE_BYTES_SHOWN) continue;
      io.out(
        t(
          "cli.git.repo_line",
          rel(r.path),
          Fmt.bytes(r.gitBytes),
          Fmt.bytes(r.looseBytes),
          branches.length,
          Fmt.bytes(r.reclaimableBytes),
          r.branches.length - branches.length,
        ),
      );
      for (const w of r.worktrees) {
        const line = t(
          "cli.git.worktree_line",
          rel(w.path),
          w.branch ?? "-",
          t(`worktree.status.${w.status}`),
          Fmt.bytes(w.size),
        );
        io.out(`    ${line}${worktrees.includes(w) ? " ✓" : ""}`);
      }
    }
    io.out(
      t(
        "cli.git.summary",
        reports.length,
        Fmt.bytes(sum(reports.map((r) => r.gitBytes))),
        branchCount,
        worktreeCount,
        Fmt.bytes(sum(plans.map((p) => p.report.reclaimableBytes))),
      ),
    );
    if (!apply) io.out(t("cli.git.simulation_note"));
  }

  if (!apply || branchCount + worktreeCount === 0) return Exit.ok;
  const question = t("cli.git.confirm", branchCount, worktreeCount, o.pruneNow ? t("cli.git.prune_warning") : "");
  if (!yes && !(await (context.confirm ?? askConfirmation)(question))) {
    io.err(t("cli.cancelled"));
    return Exit.failure;
  }
  // Même verrou que la sauvegarde : gc et prune ne doivent pas réécrire un .git en cours de copie.
  let failures: string[];
  try {
    failures = (await applyCleanup({ stateDir: store.paths.state }, plans, o)).failures;
  } catch (error) {
    if (error instanceof OperationLockError && error.reason === "alreadyHeld") {
      io.err(t("cli.busy"));
      return Exit.failure;
    }
    throw error;
  }
  for (const f of failures) io.err(t("cli.git.failed", f));
  return failures.length === 0 ? Exit.ok : Exit.failure;
}
