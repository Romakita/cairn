import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CairnPaths, expandTilde } from "../../src/core/paths.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const permissions = async (p: string) => (await stat(p)).mode & 0o777;

describe("CairnPaths", () => {
  test("paths_created_with_700", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(path.join(dir, ".cairn"));
      await paths.ensure();
      expect(await permissions(paths.root)).toBe(0o700);
      expect(existsSync(paths.logs)).toBe(true);
      expect(existsSync(paths.state)).toBe(true);
    });
  });

  test("ensure remet en 700 une racine existante", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, ".cairn");
      await mkdir(root, { mode: 0o755 });
      await new CairnPaths(root).ensure();
      expect(await permissions(root)).toBe(0o700);
    });
  });

  test("CAIRN_HOME remplace ~/.cairn ; fichiers à leur place", () => {
    const paths = new CairnPaths();
    expect(paths.root).toBe(process.env.CAIRN_HOME as string);
    expect(paths.config).toBe(path.join(paths.root, "config.toml"));
    expect(paths.logs).toBe(path.join(paths.root, "logs"));
    expect(paths.state).toBe(path.join(paths.root, "state"));
    expect(paths.operationLock).toBe(path.join(paths.root, "state", "operation.lock"));
  });

  test("sans CAIRN_HOME : ~/.cairn", () => {
    const saved = process.env.CAIRN_HOME;
    try {
      process.env.CAIRN_HOME = "";
      expect(new CairnPaths().root).toBe(path.join(os.homedir(), ".cairn"));
    } finally {
      process.env.CAIRN_HOME = saved;
    }
  });

  test("prepare crée une racine absente en 700, sans toucher une racine existante", async () => {
    await withTempDir(async (dir) => {
      const fresh = new CairnPaths(path.join(dir, ".cairn"));
      await fresh.prepare(fresh.logs);
      expect(await permissions(fresh.root)).toBe(0o700);
      expect(existsSync(fresh.state)).toBe(true);

      const mine = path.join(dir, "mine");
      await mkdir(mine, { mode: 0o755 });
      const chosen = new CairnPaths(mine);
      await chosen.prepare(chosen.state);
      expect(await permissions(mine)).toBe(0o755);
      expect(existsSync(chosen.state)).toBe(true);
    });
  });

  test("--config : racine = dossier du fichier, chemin développé et absolu", () => {
    const { paths, file } = CairnPaths.forConfigFile("~/conf/c.toml");
    expect(file).toBe(path.join(os.homedir(), "conf", "c.toml"));
    expect(paths.root).toBe(path.join(os.homedir(), "conf"));
    expect(paths.operationLock).toBe(path.join(os.homedir(), "conf", "state", "operation.lock"));
    expect(CairnPaths.forConfigFile("rel/c.toml").file).toBe(path.resolve("rel/c.toml"));
  });

  test("expandTilde", () => {
    expect(expandTilde("~")).toBe(os.homedir());
    expect(expandTilde("~/Projets")).toBe(path.join(os.homedir(), "Projets"));
    expect(expandTilde("/tmp/~x")).toBe("/tmp/~x");
  });
});
