// Nettoyage git : worktrees puis branches, journal, SHA revérifié, compactage, verrou (port de GitTests.swift et
// StorageWarningTests.prune_now_without_gc_prunes_objects ; spec git-maintenance « Optimisation »).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyze, refreshSizes } from "../../src/core/git/analysis.ts";
import { applyCleanup, applyRepo, DELETION_LOG } from "../../src/core/git/apply.ts";
import { defaultScannerDeps } from "../../src/core/git/deps.ts";
import { tsv } from "../../src/core/git/report-tsv.ts";
import { planFor, removing, selectedWorktreeByDefault } from "../../src/core/git/selection.ts";
import { defaultGitOptions } from "../../src/core/git/types.ts";
import { OperationLock, OperationLockError } from "../../src/core/lock.ts";
import {
  commit,
  git,
  makeFixture,
  objectExists,
  removeDir,
  repoWithLooseBranch,
  tempDir,
} from "../helpers/git-fixture.ts";
import { nativeAvailable } from "../helpers/native.ts";

const lockable = nativeAvailable();

const dirs: string[] = [];
function temp(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/** Nombre d'objets non compressés (`count-objects -v`, ligne `count`). */
function looseCount(repo: string): number {
  const line = git(repo, "count-objects", "-v")
    .split("\n")
    .find((l) => l.startsWith("count:"));
  return Number(line?.split(":")[1]?.trim() ?? "0");
}

describe("git-apply", () => {
  test("apply logs the SHA and the branch can be recreated", async () => {
    const dir = temp();
    const repo = makeFixture(dir);
    const shaMerged = git(repo, "rev-parse", "refs/heads/feat-merged");
    const o = defaultGitOptions({ gc: false });
    const r = await analyze(repo, o, defaultScannerDeps);
    const wts = r.worktrees.filter((w) => selectedWorktreeByDefault(w, o));
    const res = await applyRepo(repo, ["feat-merged", "feat-squash", "feat-wt"], wts, o);
    expect(res.failures).toEqual([]);
    expect(res.deletedBranches.sort()).toEqual(["feat-merged", "feat-squash", "feat-wt"]);
    expect(existsSync(path.join(repo, ".claude/worktrees/wt"))).toBe(false);
    expect(existsSync(path.join(dir, "work/app-risk/dirty.txt"))).toBe(true); // worktree à risque intact
    const log = readFileSync(path.join(repo, ".git", DELETION_LOG), "utf8");
    expect(log).toContain(`feat-merged\t${shaMerged}`);
    expect(log).toContain("worktree\t");
    // Format exact : date locale à la seconde, tabulations.
    const lines = log.trimEnd().split("\n");
    for (const l of lines) expect(l).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\t/);
    const wtLine = lines.find((l) => l.includes("\tworktree\t") && l.includes("/wt\t"))!;
    const wt = wts.find((w) => w.path.endsWith("/wt"))!;
    expect(wtLine.split("\t").slice(1)).toEqual(["worktree", wt.path, "feat-wt", wt.head]);
    expect(
      lines
        .find((l) => l.includes("\tfeat-merged\t"))!
        .split("\t")
        .slice(1),
    ).toEqual(["feat-merged", shaMerged]);
    git(repo, "branch", "feat-merged", shaMerged);
    expect(git(repo, "rev-parse", "refs/heads/feat-merged")).toBe(shaMerged);
  }, 60_000);

  test("worktrees-only cleanup with a TSV report (cairn git --worktrees-only --apply --no-gc --report)", async () => {
    const dir = temp();
    const repo = makeFixture(dir);
    const root = path.join(dir, "work");
    const o = defaultGitOptions({ worktreesOnly: true, gc: false });
    const r = await analyze(repo, o, defaultScannerDeps);
    const report = path.join(dir, "report.tsv");
    writeFileSync(report, tsv([r], root));
    const plan = planFor(r, o);
    expect(plan.branches).toEqual([]);
    const res = await applyRepo(
      repo,
      plan.branches.map((b) => b.name),
      plan.worktrees,
      o,
    );
    expect(res.failures).toEqual([]);
    const text = readFileSync(report, "utf8");
    expect(text.startsWith("repo\tbranche\tstatut\tsha\tdernier_commit\tsujet\n")).toBe(true);
    expect(text).toContain("\tfeat-squash\tsquash\t");
    // Branches intactes, worktree à risque gardé, orphelin retiré de git.
    expect(git(repo, "branch", "--list", "feat-merged")).toContain("feat-merged");
    const list = git(repo, "worktree", "list");
    expect(list).toContain("app-risk");
    expect(list).not.toContain("app-orphan");
    expect(list).not.toContain("/wt ");
  }, 60_000);

  test("a deletion updates one repository without a new analysis", async () => {
    const repo = makeFixture(temp());
    const o = defaultGitOptions({ gc: false });
    const r = await analyze(repo, o, defaultScannerDeps);
    const wt = r.worktrees.find((w) => w.path.endsWith("/wt"))!;
    const res = await applyRepo(repo, [], [wt], o);
    expect(res.removedWorktrees).toEqual([wt.path]);
    const after = removing(r, new Set(res.deletedBranches), new Set(res.removedWorktrees));
    expect(after.worktrees.some((w) => w.path === wt.path)).toBe(false); // retiré du rapport
    expect(after.worktrees.length).toBe(r.worktrees.length - 1);
    expect(after.branches.find((b) => b.name === "feat-wt")?.checkedOutInWorktree).toBeNull(); // redevient libre
    const refreshed = await refreshSizes(after, o);
    expect(refreshed.branches.map((b) => b.name)).toEqual(after.branches.map((b) => b.name));
    expect(refreshed.gitBytes).toBeGreaterThan(0);
  }, 60_000);

  test("apply skips a branch moved since the analysis", async () => {
    const repo = makeFixture(temp());
    const sha = git(repo, "rev-parse", "refs/heads/feat-merged");
    const o = defaultGitOptions({ gc: false });
    const res = await applyRepo(repo, ["feat-merged"], [], o, { "feat-merged": "0000000" });
    expect(res.failures).toEqual(["feat-merged"]);
    expect(git(repo, "rev-parse", "refs/heads/feat-merged")).toBe(sha); // branche gardée
    const ok = await applyRepo(repo, ["feat-merged"], [], o, { "feat-merged": sha.slice(0, 7) });
    expect(ok.deletedBranches).toEqual(["feat-merged"]);
  }, 60_000);

  test("prune now without gc still prunes objects", async () => {
    const dir = temp();
    const o = defaultGitOptions({ gc: false });
    // Témoin : sans « libérer immédiatement », l'objet reste (reflog).
    const keep = repoWithLooseBranch(path.join(dir, "keep"));
    await applyRepo(keep.repo, ["tmp"], [], o);
    expect(objectExists(keep.repo, keep.sha)).toBe(true);
    const pruned = repoWithLooseBranch(path.join(dir, "prune"));
    const res = await applyRepo(pruned.repo, ["tmp"], [], { ...o, pruneNow: true });
    expect(res.deletedBranches).toEqual(["tmp"]);
    expect(objectExists(pruned.repo, pruned.sha)).toBe(false); // élagué malgré gc désactivé
  }, 30_000);

  test.skipIf(!lockable)(
    "git gc only runs on the repositories that were cleaned",
    async () => {
      // Spec git-maintenance, « Optimisation » : gc sur les dépôts choisis (la 0.8.0 le lançait sur tous les dépôts
      // analysés, design.md décision 12).
      const dir = temp();
      const cleaned = repoWithLooseBranch(path.join(dir, "cleaned"));
      const untouched = repoWithLooseBranch(path.join(dir, "untouched"));
      const o = defaultGitOptions({ gc: true });
      const deps = defaultScannerDeps;
      const reports = [await analyze(cleaned.repo, o, deps), await analyze(untouched.repo, o, deps)];
      const looseBefore = looseCount(untouched.repo);
      expect(looseBefore).toBeGreaterThan(0);
      const paths = { stateDir: path.join(dir, "state") };
      const tmp = { repo: cleaned.repo, name: "tmp", status: "unmerged", sha: cleaned.sha.slice(0, 7) } as const;
      const res = await applyCleanup(
        paths,
        [
          {
            report: reports[0]!,
            branches: [{ ...tmp, date: "", subject: "", checkedOutInWorktree: null }],
            worktrees: [],
          },
          { report: reports[1]!, branches: [], worktrees: [] },
        ],
        o,
      );
      expect(res.deletedBranches).toEqual(["tmp"]);
      expect(res.cleanedRepos).toEqual([cleaned.repo]);
      expect(looseCount(cleaned.repo)).toBe(0); // gc a tout empaqueté
      expect(looseCount(untouched.repo)).toBe(looseBefore); // aucun gc
      expect(existsSync(path.join(untouched.repo, ".git", DELETION_LOG))).toBe(false);
    },
    30_000,
  );

  test.skipIf(!lockable)(
    "cleanup takes the git-clean operation lock and refuses while it is held",
    async () => {
      const dir = temp();
      const { repo, sha } = repoWithLooseBranch(dir);
      const r = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
      const paths = { stateDir: path.join(dir, "state") };
      const plan = {
        report: r,
        branches: [
          { repo, name: "tmp", status: "unmerged" as const, sha, date: "", subject: "", checkedOutInWorktree: null },
        ],
        worktrees: [],
      };
      const held = new OperationLock(paths);
      await held.acquire("backup");
      try {
        await expect(applyCleanup(paths, [plan], defaultGitOptions({ gc: false }))).rejects.toBeInstanceOf(
          OperationLockError,
        );
        expect(git(repo, "rev-parse", "refs/heads/tmp")).toBe(sha); // rien supprimé
      } finally {
        await held.release();
      }
      const res = await applyCleanup(paths, [plan], defaultGitOptions({ gc: false }));
      expect(res.deletedBranches).toEqual(["tmp"]);
      expect(await OperationLock.isHeld(paths)).toBe(false); // libéré à la fin
    },
    30_000,
  );

  test("a merged worktree branch is deleted with its worktree", async () => {
    const dir = temp();
    const repo = path.join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    commit(repo, "a.txt", "base\n", "base");
    const wtPath = path.join(dir, "repo-feat");
    git(repo, "worktree", "add", "-q", "-b", "feat", wtPath, "main");
    commit(wtPath, "f.txt", "feature\n", "feature");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
    const r = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
    const plan = planFor(r, defaultGitOptions());
    const res = await applyRepo(
      repo,
      plan.branches.map((b) => b.name),
      plan.worktrees,
      defaultGitOptions(),
    );
    expect(res.failures).toEqual([]);
    expect(res.deletedBranches).toEqual(["feat"]);
    expect(git(repo, "branch", "--list", "feat")).toBe("");
  }, 30_000);
});
