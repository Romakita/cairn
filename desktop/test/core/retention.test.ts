// Rétention (port de `tiered_retention` et `reduced_retention_lists_excess_without_deleting` de BackupTests.swift,
// `retention_shortening_detection` de BackupWarningTests.swift) et suppression manuelle sous le verrou d'opération.
import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dateOfVersion, listVersions } from "../../src/core/backup/versions.ts";
import { RECOMMENDED_RETENTION } from "../../src/core/config.ts";
import { OperationLock, OperationLockError } from "../../src/core/lock.ts";
import {
  coverage,
  deleteExcessVersions,
  excessVersions,
  isoWeekKey,
  keepVersions,
  mayDeleteMore,
  retentionChangeDecision,
  uniqueBytes,
} from "../../src/core/retention.ts";
import { nativeAvailable } from "../helpers/native.ts";

const DAY = 86_400_000;
const date = (name: string): Date => dateOfVersion(name)!;

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cairn-retention-"));
}

describe("retention", () => {
  test("tiered_retention", () => {
    const now = date("2026-11-08T120000");
    const daily = Array.from({ length: 60 }, (_, i) => new Date(now.getTime() - i * DAY));
    const keep = keepVersions(daily, { mode: "tiered", days: 30, weeks: 48 }, now);
    const recent = daily.filter((d) => now.getTime() - d.getTime() <= 30 * DAY);
    expect(recent.every((d) => keep.has(d.getTime()))).toBe(true); // toutes les quotidiennes des 30 derniers jours
    const older = [...keep].filter((t) => now.getTime() - t > 30 * DAY);
    expect(older.length).toBeGreaterThanOrEqual(4); // une par semaine avant
    expect(older.length).toBeLessThanOrEqual(6);
    const ancient = new Date(now.getTime() - 400 * DAY);
    expect(keepVersions([...daily, ancient], RECOMMENDED_RETENTION, now).has(ancient.getTime())).toBe(false);
    const count = keepVersions(daily, { mode: "count", count: 12 }, now);
    expect(count.size).toBe(12);
    expect(count.has(daily[0]!.getTime()) && count.has(daily[11]!.getTime()) && !count.has(daily[12]!.getTime())).toBe(
      true,
    );
    expect(coverage(RECOMMENDED_RETENTION, "daily").maxVersions).toBe(78);
  });

  test("ISO weeks are computed in UTC; the newest version is always kept", () => {
    expect(isoWeekKey(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-1"); // jeudi
    expect(isoWeekKey(new Date(Date.UTC(2027, 0, 1)))).toBe("2026-53"); // vendredi de la semaine 53 de 2026
    expect(isoWeekKey(new Date(Date.UTC(2024, 11, 30)))).toBe("2025-1"); // lundi
    // Dimanche 23:30 UTC et lundi 00:30 UTC : deux semaines différentes, quel que soit le fuseau local.
    expect(isoWeekKey(new Date(Date.UTC(2026, 2, 8, 23, 30)))).not.toBe(
      isoWeekKey(new Date(Date.UTC(2026, 2, 9, 0, 30))),
    );
    const now = new Date(Date.UTC(2026, 10, 8));
    const old = new Date(now.getTime() - 900 * DAY);
    expect([...keepVersions([old], { mode: "tiered", days: 1, weeks: 1 }, now)]).toEqual([old.getTime()]);
    expect(keepVersions([old, now], { mode: "count", count: 0 }, now).size).toBe(1);
  });

  test("coverage", () => {
    expect(coverage({ mode: "tiered", days: 30, weeks: 48 }, "weekly")).toEqual({ maxVersions: 5 + 48, days: 366 });
    expect(coverage({ mode: "count", count: 10 }, "weekly")).toEqual({ maxVersions: 10, days: 70 });
    expect(coverage({ mode: "count", count: 10 }, "daily")).toEqual({ maxVersions: 10, days: 10 });
  });

  test("reduced_retention_lists_excess_without_deleting", async () => {
    const versions = path.join(await tempDir(), "v");
    for (let i = 1; i <= 20; i++) {
      await mkdir(path.join(versions, `2026-10-${String(i).padStart(2, "0")}T120000`), { recursive: true });
    }
    const excess = await excessVersions(versions, { mode: "count", count: 12 }, date("2026-11-08T120000"));
    expect(excess.length).toBe(8);
    expect((await listVersions(versions)).length).toBe(20); // rien n'est supprimé avant confirmation
  });

  test("partial versions: out of the policy, excess once a newer complete version exists", async () => {
    const versions = path.join(await tempDir(), "v");
    for (const [name, partial] of [
      ["2026-10-01T120000", false],
      ["2026-10-02T120000", true],
      ["2026-10-03T120000", false],
      ["2026-10-04T120000", true],
    ] as const) {
      await mkdir(path.join(versions, name), { recursive: true });
      await writeFile(path.join(versions, name, "manifest.json"), JSON.stringify({ partial }));
    }
    const excess = await excessVersions(versions, { mode: "count", count: 1 }, date("2026-11-08T120000"));
    expect(excess).toEqual(["2026-10-01T120000", "2026-10-02T120000"]);
  });

  test("retention_shortening_detection", () => {
    expect(mayDeleteMore({ mode: "count", count: 5 }, { mode: "count", count: 12 })).toBe(true);
    expect(mayDeleteMore({ mode: "count", count: 20 }, { mode: "count", count: 12 })).toBe(false);
    expect(mayDeleteMore({ mode: "tiered", days: 14, weeks: 48 }, RECOMMENDED_RETENTION)).toBe(true); // moins de jours
    expect(mayDeleteMore({ mode: "tiered", days: 30, weeks: 10 }, RECOMMENDED_RETENTION)).toBe(true); // moins de semaines
    expect(mayDeleteMore({ mode: "tiered", days: 60, weeks: 48 }, RECOMMENDED_RETENTION)).toBe(false);
    expect(mayDeleteMore({ mode: "count", count: 1000 }, RECOMMENDED_RETENTION)).toBe(true); // changement de type
  });

  test("retention change in the settings: apply, confirm or refuse when unreadable", () => {
    const shorter = { mode: "count", count: 5 } as const;
    const longer = { mode: "count", count: 50 } as const;
    const old = { mode: "count", count: 12 } as const;
    expect(retentionChangeDecision(shorter, old, { names: ["2026-10-01T120000"], bytes: 10 })).toBe("confirm");
    expect(retentionChangeDecision(shorter, old, { names: [], bytes: 0 })).toBe("apply");
    expect(retentionChangeDecision(shorter, old, null)).toBe("unreachable");
    expect(retentionChangeDecision(longer, old, null)).toBe("apply");
  });

  test("unique bytes count files whose every hard link is in the removed versions", async () => {
    const dir = await tempDir();
    const [a, b, c] = ["a", "b", "c"].map((n) => path.join(dir, n)) as [string, string, string];
    for (const d of [a, b, c]) await mkdir(d);
    await writeFile(path.join(a, "only-a"), Buffer.alloc(8192));
    await writeFile(path.join(a, "shared-ab"), Buffer.alloc(8192));
    await link(path.join(a, "shared-ab"), path.join(b, "shared-ab"));
    await writeFile(path.join(a, "shared-ac"), Buffer.alloc(8192));
    await link(path.join(a, "shared-ac"), path.join(c, "shared-ac"));
    const one = await uniqueBytes([a]);
    expect(one).toBeGreaterThanOrEqual(8192);
    const both = await uniqueBytes([a, b]);
    expect(both).toBeGreaterThanOrEqual(2 * 8192);
    expect(both).toBeLessThan(3 * 8192 + 1); // shared-ac reste dans c
    expect(await uniqueBytes([path.join(dir, "absent")])).toBe(0);
  });
});

describe.skipIf(!nativeAvailable())("retention: manual deletion", () => {
  test("deletes confirmed versions under the operation lock, then compacts", async () => {
    const dir = await tempDir();
    const paths = { stateDir: path.join(dir, "state") };
    const versions = path.join(dir, "v");
    for (const n of ["2026-10-01T120000", "2026-10-02T120000", "2026-10-03T120000"]) {
      await mkdir(path.join(versions, n), { recursive: true });
    }
    const closes: boolean[] = [];
    let heldDuring = false;
    const result = await deleteExcessVersions(
      paths,
      ["2026-10-01T120000", "../escape", "2026-10-02T120000"],
      async () => {
        heldDuring = await OperationLock.isHeld(paths);
        return { versionsDir: versions, close: async ({ compact }) => void closes.push(compact) };
      },
    );
    expect(heldDuring).toBe(true);
    expect(result).toEqual({ deleted: ["2026-10-01T120000", "2026-10-02T120000"], failed: ["../escape"] });
    expect(await readdir(versions)).toEqual(["2026-10-03T120000"]);
    expect(closes).toEqual([true]);
    expect(await OperationLock.isHeld(paths)).toBe(false);
  });

  test("refused while another operation holds the lock: nothing is deleted", async () => {
    const dir = await tempDir();
    const paths = { stateDir: path.join(dir, "state") };
    const versions = path.join(dir, "v");
    await mkdir(path.join(versions, "2026-10-01T120000"), { recursive: true });
    const backup = new OperationLock(paths);
    await backup.acquire("backup");
    let opened = false;
    try {
      const error = await deleteExcessVersions(paths, ["2026-10-01T120000"], async () => {
        opened = true;
        return { versionsDir: versions, close: async () => {} };
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OperationLockError);
    } finally {
      await backup.release();
    }
    expect(opened).toBe(false);
    expect(await readdir(versions)).toEqual(["2026-10-01T120000"]);
  });
});
