// Journal d'activité (port de HubTests.swift : activity_*) et régression 85501aa.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTIVITY_MAX_LINES,
  ActivityLog,
  backupDays,
  decodeActivityEvent,
  encodeActivityEvent,
} from "../../src/core/activity-log.ts";
import { nativeAvailable, swiftTestHelper } from "../helpers/native.ts";

const available = nativeAvailable();
const swiftHelper = swiftTestHelper();
const now = new Date("2026-11-08T10:00:00Z");

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cairn-activity-"));
}

function run(executable: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

describe("activity-log", () => {
  test("line format is identical to the 0.8.0 (sorted keys, ISO date without milliseconds)", () => {
    expect(encodeActivityEvent({ date: new Date("2026-11-08T10:00:00.789Z"), kind: "check", count: 3 })).toBe(
      '{"count":3,"date":"2026-11-08T10:00:00Z","kind":"check"}',
    );
    expect(
      encodeActivityEvent({
        date: now,
        kind: "diskAlert",
        subject: "Macintosh HD/x",
        bytes: 1_234_567_890_123,
        level: "critical",
      }),
    ).toBe(
      '{"bytes":1234567890123,"date":"2026-11-08T10:00:00Z","kind":"diskAlert","level":"critical","subject":"Macintosh HD\\/x"}',
    );
  });

  test("decoding skips unreadable lines like the Swift decoder", () => {
    expect(decodeActivityEvent('{"date":"2026-11-08T10:00:00Z","kind":"cleanup","count":2}')).toEqual({
      date: now,
      kind: "cleanup",
      count: 2,
    });
    expect(decodeActivityEvent("not json")).toBeNull();
    expect(decodeActivityEvent('{"date":"2026-11-08T10:00:00Z","kind":"unknown"}')).toBeNull();
    expect(decodeActivityEvent('{"date":"yesterday","kind":"check"}')).toBeNull();
    expect(decodeActivityEvent('{"date":"2026-11-08T10:00:00Z","kind":"check","count":"2"}')).toBeNull();
  });

  test.skipIf(!available)("missing file", async () => {
    expect(await new ActivityLog({ stateDir: path.join(tempRoot(), "state") }).recent(10)).toEqual([]);
  });

  test.skipIf(!available)("most recent first and capped at 200 lines", async () => {
    const log = new ActivityLog({ stateDir: path.join(tempRoot(), "state") });
    for (let n = 0; n < 205; n++) {
      await log.append({ date: new Date(now.getTime() + n * 1000), kind: "check", count: n });
    }
    const lines = readFileSync(log.file, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(ACTIVITY_MAX_LINES);
    expect((await log.recent(10)).map((e) => e.count ?? -1)).toEqual(Array.from({ length: 10 }, (_, i) => 204 - i));
    expect((await log.recent(500)).at(-1)?.count).toBe(5);
    expect(readFileSync(log.file, "utf8").endsWith("}\n")).toBe(true);
  });

  test.skipIf(!available)("concurrent appends in one process keep every event", async () => {
    const log = new ActivityLog({ stateDir: path.join(tempRoot(), "state") });
    await Promise.all(Array.from({ length: 50 }, (_, n) => log.append({ date: now, kind: "check", count: n })));
    expect((await log.recent(500)).length).toBe(50);
  });

  test.skipIf(!available)("reads lines written by the 0.8.0 and keeps them", async () => {
    const stateDir = path.join(tempRoot(), "state");
    mkdirSync(stateDir, { recursive: true });
    const swiftLine = '{"count":1,"date":"2026-11-08T09:00:00Z","kind":"gitCleanup","subject":"repo"}';
    writeFileSync(path.join(stateDir, "activity.jsonl"), `${swiftLine}\n`);
    const log = new ActivityLog({ stateDir });
    await log.append({ date: now, kind: "backupSucceeded", subject: "disk" });
    expect(readFileSync(log.file, "utf8")).toBe(
      `${swiftLine}\n{"date":"2026-11-08T10:00:00Z","kind":"backupSucceeded","subject":"disk"}\n`,
    );
    expect((await log.recent(10)).map((e) => e.kind)).toEqual(["backupSucceeded", "gitCleanup"]);
  });

  test("backup days over a week", () => {
    const day = 86_400_000;
    const at = (offset: number) => new Date(now.getTime() + offset);
    const events = [
      { date: at(-10 * day), kind: "backupSucceeded" as const }, // hors fenêtre
      { date: at(-2 * day), kind: "backupFailed" as const },
      { date: at(-1 * day), kind: "backupFailed" as const },
      { date: at(-1 * day + 60_000), kind: "backupSucceeded" as const },
      { date: now, kind: "cleanup" as const },
    ];
    expect(backupDays(events, { days: 7, now, timeZone: "utc" })).toEqual([null, null, null, null, false, true, null]);
  });

  // 🐞 85501aa : des événements étaient perdus quand l'app et la CLI écrivaient en même temps.
  test.skipIf(!available)(
    "85501aa: 8 processes × 20 appends keep 160 events",
    async () => {
      const root = tempRoot();
      const stateDir = path.join(root, "state");
      const script = path.resolve(import.meta.dir, "../helpers/append-activity.ts");
      const codes = await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, [script, stateDir, "20"])));
      expect(codes).toEqual(Array(8).fill(0));
      expect((await new ActivityLog({ stateDir }).recent(500)).length).toBe(160);
    },
    60_000,
  );

  test.skipIf(!available || !swiftHelper)(
    "85501aa: Swift 0.8.0 and TypeScript writers share the lock",
    async () => {
      const root = tempRoot();
      const stateDir = path.join(root, "state");
      const script = path.resolve(import.meta.dir, "../helpers/append-activity.ts");
      const codes = await Promise.all([
        ...Array.from({ length: 4 }, () => run(process.execPath, [script, stateDir, "20"])),
        // CairnTestHelper prend la racine CAIRN (il écrit dans <racine>/state).
        ...Array.from({ length: 4 }, () => run(swiftHelper!, ["--append-activity", root, "20"])),
      ]);
      expect(codes).toEqual(Array(8).fill(0));
      const lines = readFileSync(path.join(stateDir, "activity.jsonl"), "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(160);
      // Chaque ligne, d'où qu'elle vienne, se relit et se réencode à l'identique.
      for (const line of lines) {
        const event = decodeActivityEvent(line);
        expect(event).not.toBeNull();
        expect(encodeActivityEvent(event!)).toBe(line);
      }
    },
    60_000,
  );
});
