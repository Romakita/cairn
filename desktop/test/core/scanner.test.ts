// Parcours de l'analyse (ScannerTests.swift, un à un) + comparaison à `du -sk`, lecture seule, `measure`, modèle
// (`detach`) et worker bundlé.
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  bytes,
  detach,
  finalizeNode,
  makeNode,
  measure,
  regenerableBytes,
  ScanContext,
  scan,
  walk,
} from "../../src/core/scanner.ts";

const exec = promisify(execFile);

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Écrit un fichier de `size` octets (zéros), dossiers compris. */
async function put(file: string, size: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size));
}

/** Taille allouée selon du (Ko → octets). */
async function du(p: string): Promise<number> {
  const { stdout } = await exec("/usr/bin/du", ["-sk", p]);
  return Number(stdout.split("\t")[0]) * 1024;
}

describe("scanner", () => {
  test("classifies_regenerable_folders", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "proj/src/main.ts"), 50_000);
      await put(path.join(dir, "proj/node_modules/x/index.js"), 300_000);
      await put(path.join(dir, "proj/package.json"), 100);
      await put(path.join(dir, "proj/build/out.js"), 120_000);
      await put(path.join(dir, "other/build/keep.txt"), 80_000); // pas de projet : sources
      const r = await scan(dir, new ScanContext());
      expect(bytes(r.root, "deps")).toBeGreaterThanOrEqual(300_000); // node_modules classé
      expect(bytes(r.root, "build")).toBeGreaterThanOrEqual(120_000); // build/ à côté de package.json
      expect(bytes(r.root, "source")).toBeGreaterThanOrEqual(130_000);
      expect(bytes(r.root, "build")).toBeLessThan(200_000); // build/ sans projet : sources
    });
  });

  test("package_caches_count_as_cache_and_apps_stay_source", async () => {
    await withTempDir(async (dir) => {
      // Profondeurs variées : listé par le parcours principal et compté par les workers (`classifyWith`).
      await put(path.join(dir, "proj/.npm-cache/_cacache/index"), 100_000);
      await put(path.join(dir, "a/b/c/.npm/_cacache/content/x"), 110_000);
      await put(path.join(dir, ".bun/install/cache/pkg/index.js"), 120_000);
      await put(path.join(dir, "deep/x/y/.bun/install/cache/pkg/index.js"), 130_000);
      await put(path.join(dir, ".bun/bin/bun"), 200_000);
      await put(path.join(dir, "Applications/WebStorm.app/Contents/Info.plist"), 300_000);
      const r = await scan(dir, new ScanContext());
      const cache = bytes(r.root, "cache");
      expect(cache).toBeGreaterThanOrEqual(460_000);
      expect(cache).toBeLessThan(600_000); // ni `.bun/bin` ni l'application
      expect(bytes(r.root, "source")).toBeGreaterThanOrEqual(500_000);
    });
  });

  test("hard_links_counted_once", async () => {
    await withTempDir(async (dir) => {
      const a = path.join(dir, "x/a.bin");
      await put(a, 1_000_000);
      await mkdir(path.join(dir, "y"));
      await link(a, path.join(dir, "y/a.bin"));
      const r = await scan(dir, new ScanContext());
      expect(r.root.size).toBeLessThan(1_500_000);
    });
  });

  test("swiftpm_build_is_regenerable", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "pkg/Package.swift"), 100);
      await put(path.join(dir, "pkg/.build/debug/bin"), 200_000);
      const r = await scan(dir, new ScanContext());
      expect(bytes(r.root, "build")).toBeGreaterThanOrEqual(200_000);
    });
  });

  test("matches_du_within_1_percent", async () => {
    await withTempDir(async (dir) => {
      // Fichiers, sous-dossiers profonds (au-delà des 2 niveaux listés), liens physiques dans et hors d'un
      // node_modules, lien symbolique, gros fichier listé (≥ 10 Mio).
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 5; j++) await put(path.join(dir, `p${i}/src/d${j}/deep/f${j}.txt`), 3_000 + i * 1_000);
      }
      await put(path.join(dir, "p0/node_modules/a/index.js"), 250_000);
      await link(path.join(dir, "p0/node_modules/a/index.js"), path.join(dir, "p1/shared.js"));
      await link(path.join(dir, "p0/node_modules/a/index.js"), path.join(dir, "top.js"));
      await put(path.join(dir, "media/big.iso"), 11 * 1024 * 1024);
      await link(path.join(dir, "media/big.iso"), path.join(dir, "p2/src/copy.iso"));
      await symlink("p0", path.join(dir, "alias"));
      const r = await scan(dir, new ScanContext());
      const ref = await du(dir);
      expect(Math.abs(r.root.size - ref) / ref).toBeLessThan(0.01);
      // Le gros fichier lié n'apparaît qu'une fois, en nœud ou en gros fichier.
      const listed: string[] = [];
      walk(r.root, (n) => {
        if (!n.isDirectory && n.name.endsWith(".iso")) listed.push(n.path);
      });
      expect(listed.length).toBe(1);
    });
  });

  test("scan_is_read_only", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "a/b/c/f.txt"), 1000);
      await put(path.join(dir, "a/node_modules/x.js"), 1000);
      const before = await snapshot(dir);
      await scan(dir, new ScanContext());
      expect(await snapshot(dir)).toEqual(before);
    });
  });

  test("progress_counts_files_bytes_and_errors", async () => {
    await withTempDir(async (dir) => {
      for (let i = 0; i < 20; i++) await put(path.join(dir, `a/b/c/f${i}`), 5_000);
      const ctx = new ScanContext();
      const r = await scan(dir, ctx);
      const s = ctx.snapshot();
      expect(s.files).toBe(20);
      expect(s.bytes).toBeGreaterThanOrEqual(100_000);
      expect(s.errors).toBe(0);
      expect(r.root.fileCount).toBe(20);
    });
  });

  test("unreadable_folder_is_an_error", async () => {
    if (process.getuid?.() === 0) return; // root lit tout
    await withTempDir(async (dir) => {
      await put(path.join(dir, "a/b/locked/f.txt"), 1000);
      const { chmod } = await import("node:fs/promises");
      await chmod(path.join(dir, "a/b/locked"), 0o000);
      try {
        const r = await scan(dir, new ScanContext());
        expect(r.errors).toBe(1);
      } finally {
        await chmod(path.join(dir, "a/b/locked"), 0o755);
      }
    });
  });

  test("measure_counts_regenerable_without_git_and_trash", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "app/node_modules/x.js"), 300_000);
      await put(path.join(dir, "app/.git/objects/pack"), 200_000);
      await put(path.join(dir, "app/src/a.ts"), 50_000);
      const m = await measure(dir);
      expect(Math.abs(m.size - (await du(dir))) / m.size).toBeLessThan(0.01);
      expect(m.regenerable).toBeGreaterThanOrEqual(300_000);
      expect(m.regenerable).toBeLessThan(400_000);
      expect((await measure(path.join(dir, "absent"))).size).toBe(0);
    });
  });

  test("detach_updates_totals", () => {
    const root = makeNode("r", "/r", true, "source");
    const a = makeNode("a", "/r/a", true, "source");
    const nm = makeNode("node_modules", "/r/a/node_modules", true, "deps");
    nm.ownBytes = 1000;
    nm.ownFileCount = 4;
    a.ownBytes = 10;
    a.children.push(nm);
    root.children.push(a);
    nm.parent = a;
    a.parent = root;
    finalizeNode(nm);
    finalizeNode(a);
    finalizeNode(root);
    expect(regenerableBytes(root)).toBe(1000);
    detach(nm);
    expect(root.size).toBe(10);
    expect(root.fileCount).toBe(0);
    expect(bytes(root, "deps")).toBe(0);
    expect(a.children).toEqual([]);
    expect(nm.parent).toBeNull();
    // L'arbre se sérialise sans cycle (parent non énumérable).
    expect(() => JSON.stringify(root)).not.toThrow();
  });

  test("bundled_worker_runs_under_node", async () => {
    // Le worker est créé depuis le texte de ses fonctions : il doit marcher une fois bundlé en CJS (minifié), comme
    // dans le main d'Electron.
    const node = await exec("/usr/bin/env", ["node", "--version"]).catch(() => null);
    if (!node) return;
    await withTempDir(async (dir) => {
      await put(path.join(dir, "tree/p/src/a/b.txt"), 40_000);
      await put(path.join(dir, "tree/p/node_modules/x/y.js"), 90_000);
      const entry = path.join(dir, "entry.ts");
      const scanner = path.resolve(import.meta.dir, "../../src/core/scanner.ts");
      await writeFile(
        entry,
        `import { scan, ScanContext, bytes } from ${JSON.stringify(scanner)};
         scan(${JSON.stringify(path.join(dir, "tree"))}, new ScanContext()).then((r) =>
           console.log(JSON.stringify({ size: r.root.size, deps: bytes(r.root, "deps") })));`,
      );
      for (const minify of [false, true]) {
        const out = path.join(dir, `out-${minify}.cjs`);
        const built = await Bun.build({ entrypoints: [entry], target: "node", format: "cjs", minify });
        expect(built.success).toBe(true);
        await writeFile(out, await (built.outputs[0] as Blob).text());
        const { stdout } = await exec("/usr/bin/env", ["node", out]);
        const r = JSON.parse(stdout) as { size: number; deps: number };
        expect(r.deps).toBeGreaterThanOrEqual(90_000);
        expect(r.size).toBeGreaterThanOrEqual(130_000);
      }
    });
  });
});

/** Chemins, tailles et dates de modification de tout l'arbre. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (p: string) => {
    const st = await stat(p);
    out.push(`${p} ${st.size} ${st.mtimeMs}`);
    if (st.isDirectory()) for (const name of (await readdir(p)).sort()) await visit(path.join(p, name));
  };
  await visit(dir);
  return out;
}
