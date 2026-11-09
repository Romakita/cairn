// Régressions de parity/behavior.md §2 qui touchent les outils IA : un test par commit (ou fichier de tests Swift).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aiParts, openToolsLogLine, SQLiteSnapshotError, snapshot } from "../../src/core/ai/index.ts";
import { type CairnConfig, defaultConfig } from "../../src/core/config.ts";
import { run } from "../../src/core/process.ts";

const SQLITE3 = "/usr/bin/sqlite3";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function put(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function makeDB(file: string, rows: number): Promise<void> {
  let sql = "PRAGMA journal_mode=WAL;\nCREATE TABLE IF NOT EXISTS t(x TEXT);\n";
  for (let i = 0; i < rows; i++) sql += `INSERT INTO t VALUES('row ${i}');\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await run(SQLITE3, [file], { stdin: sql, stderr: "ignore" });
}

async function count(file: string): Promise<number> {
  const r = await run(SQLITE3, ["-readonly", file, "SELECT count(*) FROM t;"], { stderr: "ignore" });
  return r.code === 0 ? Number(r.stdout.trim()) : -1;
}

function configWith(ai: CairnConfig["ai"]): CairnConfig {
  const c = defaultConfig();
  c.ai = ai;
  return c;
}

/** Copie d'une partie comme le moteur : `rsync -a --exclude-from -r --files-from src/ dst/`. */
async function copyPart(
  part: { source: string; excludes: string[]; filesFrom: string[] | null },
  dest: string,
  tmp: string,
): Promise<void> {
  await mkdir(tmp, { recursive: true });
  await mkdir(dest, { recursive: true });
  const ex = path.join(tmp, "exclude.txt");
  await writeFile(ex, part.excludes.map((e) => `${e}\n`).join(""));
  const args = ["-a", `--exclude-from=${ex}`];
  if (part.filesFrom) {
    const ff = path.join(tmp, "files.txt");
    await writeFile(ff, part.filesFrom.map((f) => `${f}\n`).join(""));
    args.push("-r", `--files-from=${ff}`);
  }
  expect((await run("/usr/bin/rsync", [...args, `${part.source}/`, `${dest}/`])).code).toBe(0);
}

describe("régressions : outils IA", () => {
  test("8d202b6: un snapshot raté ne laisse aucun fichier, une base à journal chaud n'est jamais lue en immutable", async () => {
    await withTempDir(async (dir) => {
      // Outil planté : base en journal classique avec un -journal chaud. La lecture seule ne peut pas la récupérer.
      const src = path.join(dir, "tool/crashed.sqlite");
      await mkdir(path.dirname(src), { recursive: true });
      await run(SQLITE3, [src, "PRAGMA journal_mode=DELETE; CREATE TABLE t(x); INSERT INTO t VALUES(1);"]);
      await writeFile(`${src}-journal`, Buffer.alloc(512, 1));
      const dst = path.join(dir, "staging/crashed.sqlite");
      const modes: boolean[] = [];
      const { sqliteBackup } = await import("../../src/core/ai/sqlite.ts");
      const spy = (s: string, d: string, immutable: boolean) => {
        modes.push(immutable);
        return sqliteBackup(s, d, immutable);
      };
      await expect(snapshot(src, dst, { backup: spy, sleep: async () => {} })).rejects.toBeInstanceOf(
        SQLiteSnapshotError,
      );
      expect(modes).toEqual([false, false, false, false, false]);
      for (const s of ["", "-journal", "-wal", "-shm"]) expect(existsSync(dst + s)).toBe(false);
      expect((await stat(`${src}-journal`)).size).toBe(512); // le journal de l'outil n'est pas touché
    });
  });

  test("65c88bb: Codex state_5.sqlite (WAL fermé sans -shm) est copié ; une base illisible avertit sans arrêter", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      await put(path.join(home, ".codex/sessions/2026/11/08/rollout-a.jsonl"), "x");
      await makeDB(path.join(home, ".codex/state_5.sqlite"), 20);
      for (const s of ["-wal", "-shm"]) await rm(path.join(home, `.codex/state_5.sqlite${s}`), { force: true });
      // Base illisible (pas du SQLite) : la sauvegarde continue, avec un avertissement.
      await put(path.join(home, ".codex/thread_history_1.sqlite"), Buffer.alloc(8192, 0x42));
      const warnings: string[] = [];
      const staging = path.join(dir, "staging");
      const parts = await aiParts(configWith([{ id: "codex", categories: ["conversations"] }]), staging, {
        home,
        running: [],
        warn: (w) => warnings.push(w),
      });
      expect(parts.map((p) => p.target)).toContain("ai/codex/meta");
      expect(await count(path.join(staging, "ai-codex/sqlite/conversations/state_5.sqlite"))).toBe(20);
      for (const s of ["-wal", "-shm"]) expect(existsSync(path.join(home, `.codex/state_5.sqlite${s}`))).toBe(false);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("ai/codex/conversations");
      expect(warnings[0]).toContain("thread_history_1.sqlite"); // l'avertissement nomme la base
      // Aucune copie vide ou partielle : la restauration l'installerait à la place de la vraie base.
      const snap = path.join(staging, "ai-codex/sqlite/conversations/thread_history_1.sqlite");
      for (const s of ["", "-journal", "-wal", "-shm"]) expect(existsSync(snap + s)).toBe(false);
    });
  });

  test("e229e52: les outils ouverts sont notés au journal et le snapshot réessaie", async () => {
    await withTempDir(async (home) => {
      await put(path.join(home, ".codex/config.toml"), "x");
      const c = configWith([{ id: "codex", categories: ["config"] }]);
      expect(await openToolsLogLine(c, { home, running: ["Codex"] })).toBe(
        "ai: open during backup (SQLite copied by snapshot): codex",
      );
      // L'outil ferme sa base pendant la copie : les essais suivants réussissent.
      const src = path.join(home, ".codex/state_5.sqlite");
      await makeDB(src, 3);
      let attempts = 0;
      const { sqliteBackup } = await import("../../src/core/ai/sqlite.ts");
      await snapshot(src, path.join(home, "snap.sqlite"), {
        backup: async (s, d, immutable) => {
          if (++attempts < 4) throw new SQLiteSnapshotError(s);
          await sqliteBackup(s, d, immutable);
        },
        sleep: async () => {},
      });
      expect(attempts).toBe(4);
      expect(await count(path.join(home, "snap.sqlite"))).toBe(3);
    });
  });

  test("RestoreWarningTests: les listes de plugins de .claude/plugins/ sont copiées, pas le cache", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      for (const f of ["installed_plugins.json", "known_marketplaces.json", "blocklist.json"]) {
        await put(path.join(home, ".claude/plugins", f), "{}");
      }
      await put(path.join(home, ".claude/plugins/cache/m/p/1/x.js"), Buffer.alloc(100));
      await put(path.join(home, ".claude/plugins/marketplaces/m/README.md"), Buffer.alloc(100));
      await put(path.join(home, ".claude/settings.json"), "{}");
      const parts = await aiParts(
        configWith([{ id: "claude-code", categories: ["config"] }]),
        path.join(dir, "staging"),
        { home, running: [] },
      );
      const config = parts.find((p) => p.target === "ai/claude-code/config");
      // Le dossier réinstallé n'est pas exclu : il contient des fichiers demandés.
      expect(config?.excludes).not.toContain(".claude/plugins/");
      const dest = path.join(dir, "dest");
      for (const p of parts) await copyPart(p, path.join(dest, p.target), path.join(dir, "tmp", p.target));
      const v = path.join(dest, "ai/claude-code/config/.claude");
      const copied = (await readdir(v, { recursive: true })).map(String);
      for (const f of ["installed_plugins.json", "known_marketplaces.json", "blocklist.json"]) {
        expect(copied).toContain(`plugins/${f}`);
      }
      expect(copied).toContain("settings.json");
      expect(copied.filter((f) => f.startsWith("plugins/cache") || f.startsWith("plugins/marketplaces"))).toEqual([]);
    });
  });
});
