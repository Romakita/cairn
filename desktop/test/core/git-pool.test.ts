// Pool de worker_threads de l'analyse git (port des tests de pool de GitTests.swift ; design.md §5).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyze } from "../../src/core/git/analysis.ts";
import { defaultScannerDeps } from "../../src/core/git/deps.ts";
import { analyzeAll, type PoolProgress } from "../../src/core/git/pool.ts";
import { preselection } from "../../src/core/git/selection.ts";
import { defaultGitOptions, type RepoReport } from "../../src/core/git/types.ts";
import { classify } from "../../src/core/regenerable.ts";
import { git, makeFixture, removeDir, tempDir } from "../helpers/git-fixture.ts";

const WORKER = path.resolve(import.meta.dir, "../../src/core/git/worker.ts");
const DESKTOP = path.resolve(import.meta.dir, "../..");

const dirs: string[] = [];
function temp(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/** Statuts d'un rapport, sans les dates (comparaison pool / analyse directe). */
function shape(r: RepoReport) {
  return {
    path: r.path,
    branches: r.branches.map((b) => [b.name, b.status, b.checkedOutInWorktree]),
    worktrees: r.worktrees.map((w) => [w.path, w.status, w.staleReason]),
    mainRef: r.mainRef,
  };
}

describe("git-pool", () => {
  test("worker pool matches the direct analysis and the analysis changes nothing", async () => {
    const dir = temp();
    const repo = makeFixture(dir);
    const before = git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const root = path.join(dir, "work");
    const local = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
    let last: PoolProgress | undefined;
    const pooled = await analyzeAll([root], defaultGitOptions(), classify, {
      workerFile: WORKER,
      progress: (p) => {
        last = p;
      },
    });
    expect(pooled.repos).toEqual([repo]);
    expect(pooled.reports.map(shape)).toEqual([shape(local)]);
    expect(pooled.reports[0]!.lastModified).toBeInstanceOf(Date); // les dates traversent le worker
    expect(last?.done).toBe(last?.total);
    expect(Object.keys(pooled.failed)).toEqual([]);
    // Simulation : aucune ref modifiée.
    expect(git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(before);
  }, 60_000);

  test("a tiny memory limit or timeout stops the worker without blocking the analysis", async () => {
    const dir = temp();
    makeFixture(dir);
    const root = path.join(dir, "work");
    for (const limits of [{ memoryLimitMb: 1 }, { timeoutMs: 1 }]) {
      let p: PoolProgress | undefined;
      const r = await analyzeAll([root], defaultGitOptions(), classify, {
        workerFile: WORKER,
        ...limits,
        progress: (x) => {
          p = x;
        },
      });
      // Un worker rapide peut finir avant la limite : chaque dépôt a soit un rapport, soit un échec.
      expect(r.reports.length + Object.keys(r.failed).length).toBe(p!.total);
      expect(p!.done).toBe(p!.total);
    }
  }, 60_000);

  test("reports stream as each repository finishes", async () => {
    const dir = temp();
    makeFixture(dir);
    const root = path.join(dir, "work");
    const streamed: RepoReport[] = [];
    let first: PoolProgress | undefined;
    const all = await analyzeAll([root], defaultGitOptions(), classify, {
      workerFile: WORKER,
      progress: (p) => {
        first ??= p;
      },
      onReport: (r) => streamed.push(r),
    });
    expect(all.reports.length).toBeGreaterThan(0);
    expect(new Set(streamed.map((r) => r.path))).toEqual(new Set(all.reports.map((r) => r.path)));
    expect(first?.done).toBe(0);
    expect(first?.total).toBe(all.reports.length);
    // Présélection calculée dépôt par dépôt = celle de l'ensemble.
    const b = new Set<string>();
    const w = new Set<string>();
    for (const r of streamed) {
      const one = preselection([r], defaultGitOptions());
      for (const x of one.branches) b.add(x);
      for (const x of one.worktrees) w.add(x);
    }
    const whole = preselection(all.reports, defaultGitOptions());
    expect(b).toEqual(whole.branches);
    expect(w).toEqual(whole.worktrees);
    expect([...whole.branches].some((id) => id.endsWith("#feat-merged"))).toBe(true);
  }, 60_000);

  test("the only filter keeps matching repositories", async () => {
    const dir = temp();
    for (const name of ["alpha", "beta"]) {
      const repo = path.join(dir, name);
      git(dir, "init", "-q", repo);
    }
    const r = await analyzeAll([dir], defaultGitOptions({ only: "bet" }), classify, { workerFile: WORKER });
    expect(r.repos).toEqual([path.join(dir, "beta")]);
  }, 30_000);

  test("bundled as CommonJS, the pool runs under Electron's Node on a real repository", async () => {
    // Le pool et son worker, bundlés comme pour l'app (`bun build --target=node --format=cjs`), dans un dossier
    // temporaire hors des sources : aucun chemin figé (`__dirname`, `import.meta`) ne doit survivre au bundle.
    const dir = temp();
    const repo = makeFixture(dir);
    const out = path.join(dir, "bundle");
    const entry = path.join(dir, "entry.ts");
    writeFileSync(
      entry,
      `import { analyzeAll } from ${JSON.stringify(path.join(DESKTOP, "src/core/git/pool.ts"))};
import { classify } from ${JSON.stringify(path.join(DESKTOP, "src/core/regenerable.ts"))};
import { defaultGitOptions } from ${JSON.stringify(path.join(DESKTOP, "src/core/git/types.ts"))};
const [workerFile, root] = process.argv.slice(2);
analyzeAll([root], defaultGitOptions(), classify, { workerFile }).then((r) => {
  console.log(JSON.stringify({ repos: r.repos, failed: r.failed, branches: r.reports.flatMap((x) => x.branches.map((b) => b.name + ":" + b.status)).sort() }));
});
`,
    );
    const bun = process.execPath;
    for (const [src, name] of [
      [entry, "pool-entry.cjs"],
      [path.join(DESKTOP, "src/core/git/worker.ts"), "git-worker.cjs"],
    ] as const) {
      execFileSync(bun, ["build", src, "--target=node", "--format=cjs", "--outfile", path.join(out, name)], {
        cwd: DESKTOP,
        stdio: ["ignore", "ignore", "inherit"],
      });
    }
    const electron = path.join(DESKTOP, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    const runtime = existsSync(electron) ? electron : "node";
    const stdout = execFileSync(
      runtime,
      [path.join(out, "pool-entry.cjs"), path.join(out, "git-worker.cjs"), path.join(dir, "work")],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 },
    );
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.repos).toEqual([repo]);
    expect(result.failed).toEqual({});
    expect(result.branches).toContain("feat-merged:merged");
    expect(result.branches).toContain("feat-squash:squash");
    expect(result.branches).toContain("feat-wip:unmerged");
  }, 120_000);
});
