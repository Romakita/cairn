// Snapshots SQLite des outils IA (port des cas SQLite d'AITests.swift, parity/behavior.md §3.5) sur de vraies bases
// temporaires créées avec /usr/bin/sqlite3 : base en écriture, base WAL fermée sans -shm (Codex state_5.sqlite),
// journal chaud, base illisible.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCleanWAL, quickCheck, SQLiteSnapshotError, snapshot, snapshotOnce } from "../../src/core/ai/sqlite.ts";
import { run, start } from "../../src/core/process.ts";

const SQLITE3 = "/usr/bin/sqlite3";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function insertSQL(rows: number, from = 0): string {
  const pad = "x".repeat(200);
  let sql = "PRAGMA journal_mode=WAL;\nCREATE TABLE IF NOT EXISTS t(x TEXT);\n";
  for (let i = from; i < from + rows; i++) sql += `INSERT INTO t VALUES('row ${i} ${pad}');\n`;
  return sql;
}

/** Base en WAL de `rows` lignes (une transaction par ligne). */
async function makeDB(file: string, rows: number): Promise<void> {
  const r = await run(SQLITE3, [file], { stdin: insertSQL(rows), stderr: "ignore" });
  expect(r.code).toBe(0);
}

async function integrityOK(file: string): Promise<boolean> {
  const r = await run(SQLITE3, ["-readonly", file, "PRAGMA integrity_check;"], { stderr: "ignore" });
  return r.code === 0 && r.stdout.trim() === "ok";
}

async function count(file: string): Promise<number> {
  const r = await run(SQLITE3, ["-readonly", file, "SELECT count(*) FROM t;"], { stderr: "ignore" });
  return r.code === 0 ? Number(r.stdout.trim()) : -1;
}

/** Base WAL fermée proprement, sans -wal ni -shm (outil quitté : SQLite embarqué de Codex). */
async function closedWAL(file: string, rows: number): Promise<void> {
  await makeDB(file, rows);
  for (const s of ["-wal", "-shm"]) await rm(file + s, { force: true });
}

const noSleep = async () => {};

describe("SQLiteSnapshot", () => {
  test("sqlite_snapshot_is_consistent_while_writing", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "live.sqlite");
      await makeDB(src, 200);
      // Écritures concurrentes pendant le snapshot.
      const writer = start(SQLITE3, [src], { stdin: insertSQL(500, 200), stderr: "ignore" });
      const dst = path.join(dir, "snap/live.sqlite");
      await snapshot(src, dst);
      await writer.result;
      expect(await integrityOK(dst)).toBe(true);
      expect(existsSync(`${dst}-wal`)).toBe(false); // pas de -wal dans la copie
      expect(existsSync(`${dst}-shm`)).toBe(false);
      const n = await count(dst);
      expect(n >= 200 && n <= 700).toBe(true);
    });
  });

  test("snapshot_is_a_standalone_rollback_journal_database", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "a.sqlite");
      await makeDB(src, 10);
      const dst = path.join(dir, "out/with space/a'b\"c.sqlite");
      await snapshot(src, dst);
      const mode = await run(SQLITE3, ["-readonly", dst, "PRAGMA journal_mode;"], { stderr: "ignore" });
      expect(mode.stdout.trim()).toBe("delete");
      expect(await count(dst)).toBe(10);
      expect(await quickCheck(dst)).toBe(true);
    });
  });

  test("sqlite_snapshot_of_closed_wal_database_without_shm", async () => {
    // Outil fermé proprement (SQLite embarqué de Codex) : base en WAL sans -wal ni -shm à côté.
    // Une ouverture en lecture seule échoue alors (SQLITE_CANTOPEN) : « Impossible de copier la base ».
    await withTempDir(async (dir) => {
      const src = path.join(dir, "state_5.sqlite");
      await closedWAL(src, 100);
      const before = await stat(src, { bigint: true });
      const dst = path.join(dir, "snap/state_5.sqlite");
      await snapshot(src, dst);
      expect(await integrityOK(dst)).toBe(true);
      expect(await count(dst)).toBe(100);
      // Rien n'est créé ni modifié à côté de la base de l'outil.
      for (const s of ["-wal", "-shm", "-journal"]) expect(existsSync(src + s)).toBe(false);
      const after = await stat(src, { bigint: true });
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.size).toBe(before.size);
    });
  });

  test("immutable_read_only_for_clean_wal_databases", async () => {
    await withTempDir(async (dir) => {
      const wal = path.join(dir, "wal.sqlite");
      await closedWAL(wal, 5);
      expect(await isCleanWAL(wal)).toBe(true); // WAL fermée proprement
      await writeFile(`${wal}-wal`, "");
      expect(await isCleanWAL(wal)).toBe(false); // -wal présent
      await rm(`${wal}-wal`);
      await writeFile(`${wal}-shm`, "");
      expect(await isCleanWAL(wal)).toBe(false); // -shm présent
      // Journal classique avec un -journal (outil planté) : récupération nécessaire, jamais d'immutable.
      const rollback = path.join(dir, "rollback.sqlite");
      await run(SQLITE3, [rollback, "PRAGMA journal_mode=DELETE; CREATE TABLE t(x); INSERT INTO t VALUES(1);"]);
      expect(await isCleanWAL(rollback)).toBe(false); // journal classique
      await writeFile(`${rollback}-journal`, Buffer.alloc(512, 1));
      expect(await isCleanWAL(rollback)).toBe(false); // -journal chaud
      await writeFile(path.join(dir, "junk.sqlite"), Buffer.alloc(100, 0x42));
      expect(await isCleanWAL(path.join(dir, "junk.sqlite"))).toBe(false); // pas du SQLite
      expect(await isCleanWAL(path.join(dir, "absent.sqlite"))).toBe(false);
    });
  });

  test("hot_journal_is_never_read_immutable", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "crashed.sqlite");
      await run(SQLITE3, [src, "PRAGMA journal_mode=DELETE; CREATE TABLE t(x); INSERT INTO t VALUES(1);"]);
      await writeFile(`${src}-journal`, Buffer.alloc(512, 1));
      const calls: boolean[] = [];
      const failing = async (_s: string, d: string, immutable: boolean) => {
        calls.push(immutable);
        await writeFile(d, "partial");
        throw new SQLiteSnapshotError(src);
      };
      const dst = path.join(dir, "snap/crashed.sqlite");
      await expect(snapshot(src, dst, { backup: failing, sleep: noSleep })).rejects.toBeInstanceOf(SQLiteSnapshotError);
      expect(calls).toEqual([false, false, false, false, false]); // 5 essais, jamais en immutable
      expect(existsSync(dst)).toBe(false);
    });
  });

  test("immutable_copy_rejected_if_the_database_moves_or_fails_quick_check", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "state.sqlite");
      await closedWAL(src, 5);
      const dst = path.join(dir, "snap/state.sqlite");
      // L'outil réécrit la base pendant la copie (checkpoint) : copie refusée et supprimée.
      const moving = async (_s: string, d: string, immutable: boolean) => {
        if (!immutable) throw new SQLiteSnapshotError(src);
        await writeFile(d, "copy");
        const later = new Date(Date.now() + 5000);
        const { utimes } = await import("node:fs/promises");
        await utimes(src, later, later);
      };
      await expect(snapshotOnce(src, dst, { backup: moving, quickCheck: async () => true })).rejects.toBeInstanceOf(
        SQLiteSnapshotError,
      );
      expect(existsSync(dst)).toBe(false);
      // quick_check en échec : copie refusée et supprimée.
      const copying = async (_s: string, d: string, immutable: boolean) => {
        if (!immutable) throw new SQLiteSnapshotError(src);
        await writeFile(d, "copy");
      };
      await expect(snapshotOnce(src, dst, { backup: copying, quickCheck: async () => false })).rejects.toBeInstanceOf(
        SQLiteSnapshotError,
      );
      expect(existsSync(dst)).toBe(false);
      await snapshotOnce(src, dst, { backup: copying, quickCheck: async () => true });
      expect(existsSync(dst)).toBe(true);
    });
  });

  test("failed_snapshot_leaves_nothing_behind", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "junk.sqlite");
      await writeFile(src, Buffer.alloc(8192, 0x42));
      const dst = path.join(dir, "snap/junk.sqlite");
      await mkdir(path.dirname(dst), { recursive: true });
      for (const s of ["-journal", "-wal", "-shm"]) await writeFile(dst + s, "stale");
      const error = await snapshot(src, dst, { sleep: noSleep }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SQLiteSnapshotError);
      expect(String((error as Error).message)).toContain("junk.sqlite");
      for (const s of ["", "-journal", "-wal", "-shm"]) expect(existsSync(dst + s)).toBe(false);
      // La source n'est pas touchée.
      expect((await stat(src)).size).toBe(8192);
      for (const s of ["-journal", "-wal", "-shm"]) expect(existsSync(src + s)).toBe(false);
    });
  });

  test("retries_until_the_tool_releases_the_database", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "busy.sqlite");
      await makeDB(src, 3);
      let attempts = 0;
      const sleeps: number[] = [];
      const flaky = async (s: string, d: string, immutable: boolean) => {
        attempts++;
        if (attempts < 3) throw new SQLiteSnapshotError(s);
        const { sqliteBackup } = await import("../../src/core/ai/sqlite.ts");
        await sqliteBackup(s, d, immutable);
      };
      const dst = path.join(dir, "snap/busy.sqlite");
      await snapshot(src, dst, { backup: flaky, sleep: async (ms) => void sleeps.push(ms) });
      expect(attempts).toBe(3);
      expect(sleeps).toEqual([100, 200]); // 100 ms × numéro d'essai
      expect(await count(dst)).toBe(3);
    });
  });
});
