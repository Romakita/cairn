// Régressions de parity/behavior.md §2 qui touchent l'analyse du disque et les alertes : un test par commit
// (ou fichier de tests Swift). Partie stockage de StorageWarningTests (2a48b67).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preselectCleanup } from "../../src/core/analysis.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { type Category, classify } from "../../src/core/regenerable.ts";
import { isOtherVolume, makeNode, ScanContext, scan } from "../../src/core/scanner.ts";
import { checkStorageAfterBackup, loadHistory } from "../../src/core/storage-alerts.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function node(name: string, category: Category, size: number) {
  const n = makeNode(name, `/r/${name}`, true, category);
  n.size = size;
  return n;
}

describe("régressions : stockage", () => {
  test("2a48b67 : l'analyse ne franchit pas les points de montage", async () => {
    await withTempDir(async (dir) => {
      const st = await lstat(dir);
      expect(isOtherVolume(st, st.dev)).toBe(false);
      expect(isOtherVolume(st, st.dev + 1)).toBe(true); // autre st_dev : autre volume
      // Sur un seul volume, les deux premiers niveaux sont toujours analysés.
      await mkdir(path.join(dir, "a/b"), { recursive: true });
      await writeFile(path.join(dir, "a/b/f.bin"), Buffer.alloc(4096));
      const r = await scan(dir, new ScanContext());
      expect(r.root.children.some((c) => c.name === "a" && c.children.some((g) => g.name === "b"))).toBe(true);
    });
    // Vrais points de montage : /Volumes ne contient que des volumes montés (et le lien vers /), jamais parcourus.
    if (existsSync("/Volumes")) {
      const r = await scan("/Volumes", new ScanContext());
      expect(r.root.size).toBeLessThan(1_000_000);
    }
  });

  test("2a48b67 : présélection du nettoyage, plus gros dossiers régénérables", () => {
    const nodes = [
      node("small", "deps", 50_000_000),
      node("big", "build", 5_000_000_000),
      node("src", "source", 9_000_000_000),
      node("mid", "deps", 800_000_000),
      node("repo.git", "git", 9_000_000_000),
    ];
    expect(preselectCleanup(nodes).map((n) => n.name)).toEqual(["big", "mid"]);
    expect(preselectCleanup(nodes, 1).map((n) => n.name)).toEqual(["big"]);
  });

  test("StorageWarningTests : la découverte git dispose de la classification du scanner", async () => {
    // GitMaintenance.discover (tâche 5.1) ignore node_modules, build à côté d'un package.json et la corbeille,
    // mais parcourt un « build » ordinaire : mêmes réponses que `classify`.
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, "web"), { recursive: true });
      await writeFile(path.join(dir, "web/package.json"), "{}");
      expect(await classify("node_modules", dir)).toBe("deps");
      expect(await classify(".Trash", dir)).toBe("trash");
      expect(await classify("build", path.join(dir, "web"))).toBe("build");
      expect(await classify("build", path.join(dir, "tools"))).toBe("source");
    });
  });

  test("design §12 : relevé des volumes aussi à la fin d'une sauvegarde", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(path.join(dir, "cairn"));
      const check = await checkStorageAfterBackup({
        paths,
        folders: [dir],
        alerts: defaultConfig().alerts,
        readVolume: async () => ({ name: "dest", total: 100e9, available: 3e9, availableImportant: 3e9 }),
      });
      expect(check.notify.map((a) => a.volume)).toEqual(["dest"]);
      expect((await loadHistory(paths)).readings.dest?.length).toBe(1);
    });
  });
});
