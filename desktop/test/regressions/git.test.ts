// Régressions de la maintenance git (parity/behavior.md §2), un test par commit corrigé.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../../src/core/config.ts";
import { analyze, isMainBranch, mergeStatus } from "../../src/core/git/analysis.ts";
import { applyCleanup, applyRepo } from "../../src/core/git/apply.ts";
import { defaultScannerDeps } from "../../src/core/git/deps.ts";
import { discover } from "../../src/core/git/discovery.ts";
import { Git, type GitResult, type GitRunOptions } from "../../src/core/git/git.ts";
import { analyzeAll, analyzeRepos, type PoolProgress } from "../../src/core/git/pool.ts";
import { defaultGitOptions, forAnalysis, type RepoReport } from "../../src/core/git/types.ts";
import { t } from "../../src/core/l10n.ts";
import { OperationLock, OperationLockError } from "../../src/core/lock.ts";
import { pipe } from "../../src/core/process.ts";
import { classify } from "../../src/core/regenerable.ts";
import { commit, git, makeFixture, removeDir, repoWithLooseBranch, tempDir } from "../helpers/git-fixture.ts";
import { nativeAvailable } from "../helpers/native.ts";

const WORKER = path.resolve(import.meta.dir, "../../src/core/git/worker.ts");
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

/** `count` dépôts d'un commit chacun, dans `<dir>/repos`. */
function smallRepos(dir: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const repo = path.join(dir, "repos", `r${i}`);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    commit(repo, "a.txt", `${i}\n`, "base");
    return repo;
  });
}

/** Git dont certaines commandes rendent un code imposé (échec de git simulé). */
class FailingGit extends Git {
  constructor(
    repo: string,
    private readonly failing: string,
    private readonly status: number,
  ) {
    super(repo);
  }
  override async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    if (args[0] === this.failing) return { status: this.status, out: "" };
    return super.run(args, options);
  }
  override async pipeLines(first: readonly string[], second: readonly string[], onLine: (l: string) => void) {
    if (first[0] === this.failing) return false; // empreinte illisible
    return super.pipeLines(first, second, onLine);
  }
}

/** Dépôt avec une branche `feat` non fusionnée (un vrai diff avec main). */
function repoWithFeature(dir: string): string {
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  commit(repo, "a.txt", "base\n", "base");
  git(repo, "checkout", "-q", "-b", "feat");
  commit(repo, "f.txt", "feature\n", "feature");
  git(repo, "checkout", "-q", "main");
  commit(repo, "m.txt", "main\n", "main moves on");
  return repo;
}

describe("regressions: git", () => {
  test("01538a8: main is protected by its short name, even checked out in a linked worktree", async () => {
    expect(isMainBranch("main", "refs/remotes/origin/main")).toBe(true);
    expect(isMainBranch("main-old", "refs/remotes/origin/main")).toBe(false);
    const dir = temp();
    const origin = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git(dir, "init", "-q", "--bare", origin);
    git(repo, "init", "-q");
    commit(repo, "a.txt", "base\n", "base");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");
    git(repo, "checkout", "-q", "-b", "dev");
    git(repo, "worktree", "add", "-q", path.join(dir, "repo-main"), "main");
    // L'amont de main disparaît : main devient « gone » mais reste protégée.
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    expect(git(repo, "for-each-ref", "refs/heads/main", "--format=%(upstream:track)")).toBe("[gone]");
    const r = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
    expect(r.mainRef).toBe("refs/remotes/origin/main");
    expect(r.branches.map((b) => b.name)).not.toContain("main");
    expect(r.worktrees.find((w) => w.branch === "main")?.branchStatus).toBeNull();
  }, 30_000);

  test("46a9475: a failing diff or patch-id never makes a branch merged", async () => {
    const repo = repoWithFeature(temp());
    expect(await mergeStatus(new Git(repo), "refs/heads/feat", "refs/heads/main")).toBe("unmerged");
    // Code de `diff --quiet` autre que 0 ou 1 (git en échec) : unmerged, jamais merged.
    for (const status of [128, 129, -1, 127]) {
      expect(await mergeStatus(new FailingGit(repo, "diff", status), "refs/heads/feat", "refs/heads/main")).toBe(
        "unmerged",
      );
    }
    // merge-base introuvable : unmerged.
    expect(await mergeStatus(new FailingGit(repo, "merge-base", 1), "refs/heads/feat", "refs/heads/main")).toBe(
      "unmerged",
    );
    expect(await mergeStatus(new Git(repo), "refs/heads/feat", null)).toBe("unmerged");
  }, 30_000);

  test("46a9475: a branch moved since the analysis is kept (short SHA prefix accepted)", async () => {
    const { repo, sha } = repoWithLooseBranch(temp());
    const o = defaultGitOptions({ gc: false });
    const moved = await applyRepo(repo, ["tmp"], [], o, { tmp: "0000000" });
    expect(moved.failures).toEqual(["tmp"]);
    expect(moved.deletedBranches).toEqual([]);
    expect(git(repo, "rev-parse", "refs/heads/tmp")).toBe(sha);
    const ok = await applyRepo(repo, ["tmp"], [], o, { tmp: sha.slice(0, 7) });
    expect(ok.deletedBranches).toEqual(["tmp"]);
  }, 30_000);

  test.skipIf(!lockable)(
    "46a9475: git cleanup runs under the git-clean operation lock",
    async () => {
      const dir = temp();
      const { repo, sha } = repoWithLooseBranch(dir);
      const r = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
      const paths = { stateDir: path.join(dir, "state") };
      const branch = {
        repo,
        name: "tmp",
        status: "unmerged" as const,
        sha,
        date: "",
        subject: "",
        checkedOutInWorktree: null,
      };
      const lock = new OperationLock(paths);
      let holder = null as string | null;
      // Pendant le nettoyage, le verrou est tenu par `git-clean`.
      const probe = async () => {
        holder = await lock.holderDescription();
      };
      await applyCleanup(
        paths,
        [{ report: r, branches: [branch], worktrees: [] }],
        defaultGitOptions({ gc: false }),
      ).then(probe);
      expect(holder).toBe(`${process.pid} git-clean`);
      const other = new OperationLock(paths);
      await other.acquire("backup");
      try {
        await expect(applyCleanup(paths, [], defaultGitOptions())).rejects.toBeInstanceOf(OperationLockError);
      } finally {
        await other.release();
      }
    },
    30_000,
  );

  test("85501aa: the full check never fetches and ignores the only filter", () => {
    const c = defaultConfig();
    c.git.fetchBefore = true;
    const check = forAnalysis(defaultGitOptions({ only: "cairn", fetch: true }), c, true);
    expect(check.fetch).toBe(false);
    expect(check.only).toBeNull();
  });

  test("8171ca8: reports stream, the first progress is done=0,total=N and stopping keeps earlier results", async () => {
    const repos = smallRepos(temp(), 5);
    const progress: PoolProgress[] = [];
    const streamed: RepoReport[] = [];
    const controller = new AbortController();
    const r = await analyzeRepos(repos, defaultGitOptions(), {
      workerFile: WORKER,
      parallel: 1,
      signal: controller.signal,
      progress: (p) => progress.push(p),
      onReport: (rep) => {
        streamed.push(rep);
        if (streamed.length === 2) controller.abort();
      },
    });
    expect(progress[0]).toEqual({ done: 0, total: 5, running: {}, failed: {} });
    expect(r.cancelled).toBe(true);
    expect(streamed.map((x) => x.path)).toEqual(repos.slice(0, 2));
    expect(r.reports.map((x) => x.path)).toEqual(repos.slice(0, 2)); // résultats gardés après l'arrêt
    // Sans arrêt, chaque rapport arrive avant la fin de l'ensemble.
    const order: string[] = [];
    const all = await analyzeRepos(repos, defaultGitOptions(), {
      workerFile: WORKER,
      onReport: (rep) => order.push(rep.path),
    });
    expect(order.length).toBe(5);
    expect(all.reports.map((x) => x.path)).toEqual(repos); // résultat final dans l'ordre des dépôts
  }, 60_000);

  test("b23d23f: every analysis goes through the worker pool, with a timeout", async () => {
    const repos = smallRepos(temp(), 2);
    let last: PoolProgress | undefined;
    const r = await analyzeRepos(repos, defaultGitOptions(), {
      workerFile: WORKER,
      timeoutMs: 1,
      progress: (p) => {
        last = p;
      },
    });
    expect(r.reports).toEqual([]);
    for (const repo of repos) expect(r.failed[repo]).toBe(t("git.worker.timeout", 0));
    expect(last?.done).toBe(2);
    expect(r.reports.length + Object.keys(r.failed).length).toBe(repos.length);
  }, 30_000);

  test("a7d22bf: a git analysis and another heavy task run together and both finish", async () => {
    const dir = temp();
    smallRepos(dir, 6);
    makeFixture(path.join(dir, "fixture"));
    mkdirSync(path.join(dir, "data"), { recursive: true });
    for (let i = 0; i < 200; i++) writeFileSync(path.join(dir, "data", `f${i}`), "x".repeat(4096));
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = Date.now();
    try {
      let piped = 0;
      const [analysis, heavy, measured] = await Promise.all([
        analyzeAll([dir], defaultGitOptions(), classify, { workerFile: WORKER }),
        // 256 Mo de `yes | head` passés en flux par le main pendant l'analyse.
        pipe(
          { executable: "/usr/bin/yes", args: [] },
          { executable: "/usr/bin/head", args: ["-c", String(256 * 1024 * 1024)] },
          {
            onData: (c) => {
              piped += c.length;
            },
          },
        ).then(() => piped),
        defaultScannerDeps.measure(path.join(dir, "data")),
      ]);
      expect(analysis.reports.length).toBe(7);
      expect(Object.keys(analysis.failed)).toEqual([]);
      expect(heavy).toBe(256 * 1024 * 1024);
      expect(measured.size).toBeGreaterThan(0);
      // Le main n'a jamais attendu de façon synchrone : la minuterie a continué de tourner.
      expect(ticks).toBeGreaterThan(((Date.now() - started) / 10) * 0.3);
    } finally {
      clearInterval(ticker);
    }
  }, 120_000);

  test("StorageWarningTests: discovery uses the scanner classification", async () => {
    const dir = temp();
    for (const p of ["app/.git", "node_modules/pkg/.git", "web/.git", "web/build/gen/.git", "tools/build/lib/.git"]) {
      mkdirSync(path.join(dir, p), { recursive: true });
    }
    writeFileSync(path.join(dir, "web/package.json"), "{}");
    const repos = (await discover([dir], classify)).map((p) => path.relative(dir, p));
    expect(repos).toEqual(["app", "tools/build/lib", "web"]);
  });
});
