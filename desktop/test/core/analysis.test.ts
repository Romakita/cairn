// Analyse de plusieurs dossiers, gros objets, projets, résumé et suppression (AnalysisTests.swift, un à un ;
// `cli_analyze_uses_config_folders` relève de la CLI) + résumé persistant (AlertTests.summary_and_history_persist,
// partie résumé) et suppression.
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  decodeSummary,
  encodeSummary,
  findBigObjects,
  findProjects,
  loadSummary,
  projectTotalSize,
  reclaimableBytes,
  regenerableNodes,
  removeNodes,
  saveSummary,
  summaryFile,
  summaryFromRoots,
  worktreeRepo,
} from "../../src/core/analysis.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { bytes, ScanContext, scan, scanFolders } from "../../src/core/scanner.ts";

const exec = promisify(execFile);

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function put(file: string, size: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size));
}

async function du(p: string): Promise<number> {
  const { stdout } = await exec("/usr/bin/du", ["-sk", p]);
  return Number(stdout.split("\t")[0]) * 1024;
}

describe("analysis", () => {
  test("scans_several_folders_and_flags_unavailable", async () => {
    await withTempDir(async (dir) => {
      const a = path.join(dir, "a");
      const b = path.join(dir, "b");
      await put(path.join(a, "x.bin"), 400_000);
      await put(path.join(b, "y.bin"), 300_000);
      // Même fichier lié dans les deux dossiers : compté une fois au total.
      await link(path.join(a, "x.bin"), path.join(b, "x.bin"));
      const scans = await scanFolders([a, b, "/nonexistent-cairn"], new ScanContext());
      expect(scans.map((s) => s.result !== null)).toEqual([true, true, false]);
      const total = scans.reduce((sum, s) => sum + (s.result?.root.size ?? 0), 0);
      expect(total).toBeLessThan(900_000);
      expect(total).toBeGreaterThanOrEqual(700_000);
      for (const s of scans) {
        if (!s.result) continue;
        expect(s.result.root.size).toBeLessThanOrEqual((await du(s.result.root.path)) + 8192);
      }
    });
  });

  test("hard_link_shared_between_workers_and_folders", async () => {
    // Variante sur des sous-arbres analysés par des workers différents (au-delà des 2 premiers niveaux).
    await withTempDir(async (dir) => {
      await put(path.join(dir, "a/p/q/r/x.bin"), 2_000_000);
      for (const sub of ["a/p/s/t", "a/u/v/w", "b/p/q/r"]) {
        await mkdir(path.join(dir, sub), { recursive: true });
        await link(path.join(dir, "a/p/q/r/x.bin"), path.join(dir, sub, "x.bin"));
      }
      const scans = await scanFolders([path.join(dir, "a"), path.join(dir, "b")], new ScanContext());
      const total = scans.reduce((sum, s) => sum + (s.result?.root.size ?? 0), 0);
      expect(total).toBeGreaterThanOrEqual(2_000_000);
      expect(total).toBeLessThan(2_200_000);
    });
  });

  test("big_objects_three_spec_cases", async () => {
    await withTempDir(async (dir) => {
      // Gros fichier (seuil 100 ko).
      await put(path.join(dir, "media/big.iso"), 400_000);
      // Beaucoup de petits fichiers : fixtures/ dépasse 1 Mo, aucun de ses sous-dossiers seul.
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 30; j++) await put(path.join(dir, `proj/fixtures/set${i}/f${j}.json`), 9_000);
      }
      // Dossier qui doit sa taille à un seul gros fichier : seul le fichier est listé.
      await put(path.join(dir, "dump/data.bin"), 1_400_000);
      await put(path.join(dir, "dump/note.txt"), 50_000);
      const r = await scan(dir, new ScanContext({ bigFileThreshold: 100_000 }));
      const objects = findBigObjects(r.root, r.bigFiles, 1_000_000);
      const names = objects.map((o) => `${o.kind}:${path.basename(o.path)}`);
      expect(names).toContain("file:big.iso");
      expect(names).toContain("file:data.bin");
      expect(names).toContain("folder:fixtures");
      expect(names).not.toContain("folder:proj");
      expect(names).not.toContain("folder:set0");
      expect(names).not.toContain("folder:dump");
    });
  });

  test("big_file_threshold_is_configurable", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "a.bin"), 3_000_000);
      const low = await scan(dir, new ScanContext({ bigFileThreshold: 1_000_000 }));
      const high = await scan(dir, new ScanContext({ bigFileThreshold: 50_000_000 }));
      expect(low.bigFiles.length).toBe(1);
      expect(high.bigFiles.length).toBe(0);
    });
  });

  test("projects_with_node_modules_and_worktrees", async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, "client/app");
      await put(path.join(repo, ".git/HEAD"), 100);
      await put(path.join(repo, "src/main.ts"), 200_000);
      await put(path.join(repo, "node_modules/x/index.js"), 600_000);
      // Worktree à l'intérieur du dépôt (agent) et worktree à côté.
      const inner = path.join(repo, ".claude/worktrees/fix");
      await put(path.join(inner, "src/main.ts"), 150_000);
      await writeFile(path.join(inner, ".git"), `gitdir: ${repo}/.git/worktrees/fix\n`);
      const outer = path.join(dir, "client/app-v2");
      await put(path.join(outer, "src/main.ts"), 120_000);
      await writeFile(path.join(outer, ".git"), `gitdir: ${repo}/.git/worktrees/app-v2\n`);
      await put(path.join(dir, "lib/package.json"), 100);

      const r = await scan(dir, new ScanContext());
      const projects = await findProjects(r.root);
      expect(new Set(projects.map((p) => p.name))).toEqual(new Set(["app", "lib"])); // worktrees : pas des projets
      const app = projects.find((p) => p.name === "app");
      expect(app).toBeDefined();
      if (!app) return;
      expect(app.isGitRepo).toBe(true);
      expect(app.regenerable).toBeGreaterThanOrEqual(600_000);
      expect(app.worktrees.length).toBe(2);
      const outerSize = app.worktrees.find((w) => w.path.endsWith("app-v2"))?.size ?? -1;
      expect(projectTotalSize(app)).toBe(app.size + outerSize);
      expect(await worktreeRepo(inner)).toBe(repo);
    });
  });

  test("worktree_repo_resolves_relative_gitdir", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "repo/.git/HEAD"), 10);
      await mkdir(path.join(dir, "wt"));
      await writeFile(path.join(dir, "wt/.git"), "gitdir: ../repo/.git/worktrees/wt\n");
      expect(await worktreeRepo(path.join(dir, "wt"))).toBe(path.join(dir, "repo"));
      expect(await worktreeRepo(path.join(dir, "repo"))).toBeNull(); // .git est un dossier
    });
  });

  test("cancel_stops_within_two_seconds", async () => {
    const target = existsSync("/Volumes/workspaces") ? "/Volumes/workspaces" : os.homedir();
    const ctx = new ScanContext();
    const running = scanFolders([target], ctx);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const start = Date.now();
    ctx.cancel();
    const scans = await Promise.race([running, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))]);
    expect(scans).not.toBeNull(); // arrêtée en moins de 2 s
    expect(Date.now() - start).toBeLessThan(2000);
    expect(scans?.[0]?.result).toBeNull(); // résultat abandonné : le précédent reste affiché
  });

  test("cancel_with_abort_signal", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "a/b/c.txt"), 10);
      const controller = new AbortController();
      controller.abort();
      const scans = await scanFolders([dir], new ScanContext({ signal: controller.signal }));
      expect(scans[0]?.result).toBeNull();
    });
  });

  // Comparaison avec du sur le vrai workspace : CAIRN_TESTS_SLOW=1 bun test ./test/core/analysis.test.ts
  test.skipIf(process.env.CAIRN_TESTS_SLOW !== "1")(
    "matches_du_on_workspaces_within_1_percent",
    async () => {
      const r = await scan("/Volumes/workspaces", new ScanContext());
      const ref = await du("/Volumes/workspaces");
      const gap = Math.abs(r.root.size - ref) / ref;
      console.log(`    Cairn ${r.root.size} o, du ${ref} o, écart ${(gap * 100).toFixed(3)} %`);
      expect(gap).toBeLessThan(0.01);
    },
    600_000,
  );

  test("summary_persists_in_0_8_0_format", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(dir);
      await put(path.join(dir, "tree/node_modules/x.js"), 200_000);
      const r = await scan(path.join(dir, "tree"), new ScanContext());
      const s = summaryFromRoots([r.root], 1000, new Date("2026-11-09T10:10:22.456Z"));
      await saveSummary(s, paths);
      const loaded = await loadSummary(paths);
      expect(loaded?.reclaimableByType.deps).toBe(bytes(r.root, "deps"));
      expect(loaded?.date.toISOString()).toBe("2026-11-09T10:10:22.000Z");
      expect(reclaimableBytes(s)).toBe(bytes(r.root, "deps") + 1000);
      // Mêmes octets que JSONEncoder (.sortedKeys, .iso8601) de la 0.8.0.
      expect(await readFile(summaryFile(paths), "utf8")).toBe(
        `{"date":"2026-11-09T10:10:22Z","obsoleteWorktreeBytes":1000,"reclaimableByType":{"build":0,"cache":0,` +
          `"deps":${bytes(r.root, "deps")},"ios":0,"python":0},"totalBytes":${r.root.size},"trashBytes":0}`,
      );
    });
  });

  test("summary_reads_file_written_by_0_8_0", () => {
    const swift =
      '{"date":"2026-11-09T10:10:22Z","obsoleteWorktreeBytes":330547200,"reclaimableByType":{"build":12386660352,' +
      '"cache":6463033344,"deps":64785391616,"ios":5437403136,"python":51355648},"totalBytes":281655709696,"trashBytes":0}';
    const s = decodeSummary(swift);
    expect(s?.totalBytes).toBe(281_655_709_696);
    expect(s?.reclaimableByType.deps).toBe(64_785_391_616);
    expect(s && encodeSummary(s)).toBe(swift);
    expect(decodeSummary("{}")).toBeNull();
    expect(decodeSummary("not json")).toBeNull();
  });

  test("remove_to_trash_updates_totals_without_rescan", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "root");
      await put(path.join(root, "a/node_modules/x/big.bin"), 12 * 1024 * 1024);
      await put(path.join(root, "a/node_modules/y.js"), 100_000);
      await put(path.join(root, "b/node_modules/z.js"), 200_000);
      await put(path.join(root, "b/src/keep.ts"), 50_000);
      const result = await scan(root, new ScanContext({ bigFileThreshold: 10_000_000 }));
      const before = result.root.size;
      const nodes = regenerableNodes(result.root);
      expect(nodes.length).toBe(2);
      expect(result.bigFiles.length).toBe(1);
      const trash = path.join(dir, "Trash");
      await mkdir(trash);
      const trashed: string[] = [];
      const r = await removeNodes(nodes, {
        permanently: false,
        result,
        trash: async (p) => {
          trashed.push(p);
          await rename(p, path.join(trash, `${trashed.length}`));
        },
      });
      expect(r.failures).toEqual([]);
      expect(r.removed.length).toBe(2);
      expect(trashed.sort()).toEqual([path.join(root, "a/node_modules"), path.join(root, "b/node_modules")]);
      expect(result.root.size).toBe(before - r.freed);
      expect(bytes(result.root, "deps")).toBe(0);
      expect(result.bigFiles).toEqual([]);
      expect(existsSync(path.join(root, "b/src/keep.ts"))).toBe(true);
    });
  });

  test("remove_permanently_and_report_failures", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "p/a/dist/x.js"), 100_000);
      await put(path.join(dir, "p/a/package.json"), 10);
      const result = await scan(dir, new ScanContext());
      const [dist] = regenerableNodes(result.root);
      expect(dist?.name).toBe("dist");
      if (!dist) return;
      const ghost = { ...dist, path: path.join(dir, "absent"), children: [] };
      const r = await removeNodes([dist, ghost], {
        permanently: true,
        trash: () => Promise.reject(new Error("corbeille non attendue")),
      });
      expect(r.removed).toEqual([dist]);
      expect(r.failures.map((f) => f.path)).toEqual([path.join(dir, "absent")]);
      expect(existsSync(path.join(dir, "p/a/dist"))).toBe(false);
      expect(bytes(result.root, "build")).toBe(0);
    });
  });
});
