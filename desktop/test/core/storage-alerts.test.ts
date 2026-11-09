// Alertes disque (AlertTests.swift, un à un ; la partie résumé de `summary_and_history_persist` est dans
// analysis.test.ts) + formats de `volumes.json` et `alerts.json`, relevé complet et capacité du volume.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/core/config.ts";
import { type NativeBinding, native, setNative } from "../../src/core/native.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import {
  AlertLevel,
  addReading,
  alertLevel,
  checkStorage,
  checkStorageAfterBackup,
  daysToFull,
  decodeHistory,
  decodeStates,
  emptyHistory,
  encodeStates,
  evaluateAlert,
  initialAlertState,
  loadAlertStates,
  loadHistory,
  saveHistory,
  snooze,
  snoozeVolume,
  type VolumeAlertState,
  type VolumeInfo,
  type VolumeReading,
  volumeInfo,
} from "../../src/core/storage-alerts.ts";

const GB = 1_000_000_000;
const total = 1000 * GB;
const alerts = () => defaultConfig().alerts;

function r(hoursAgo: number, freeGB: number, now: Date): VolumeReading {
  return { date: new Date(now.getTime() - hoursAgo * 3_600_000), available: freeGB * GB, total };
}

function later(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let savedNative: NativeBinding | null = null;
try {
  savedNative = native();
} catch {
  savedNative = null;
}
afterEach(() => setNative(savedNative));

describe("storage-alerts", () => {
  test("thresholds", () => {
    const a = alerts();
    expect(alertLevel(200 * GB, total, a)).toBe(AlertLevel.ok);
    expect(alertLevel(90 * GB, total, a)).toBe(AlertLevel.low); // 9 %
    expect(alertLevel(40 * GB, total, a)).toBe(AlertLevel.critical); // 4 %
    expect(alertLevel(15 * GB, 100 * GB, a)).toBe(AlertLevel.low); // 15 % mais < 20 Go
  });

  test("oscillation_notifies_once_per_day", () => {
    const a = alerts();
    const now = new Date();
    let state = initialAlertState();
    let sent = 0;
    for (const [i, free] of [98, 102, 98, 102, 98].entries()) {
      const e = evaluateAlert("w", r(5 - i, free, now), [], state, a, later(now, i * 3_600_000));
      state = e.state;
      if (e.alert) sent += 1;
    }
    expect(sent).toBe(1);
  });

  test("critical_escalation_is_immediate", () => {
    const a = alerts();
    const now = new Date();
    let e = evaluateAlert("w", r(0, 90, now), [], initialAlertState(), a, now);
    expect(e.alert?.level).toBe(AlertLevel.low);
    const t = later(now, 4 * 3_600_000);
    e = evaluateAlert("w", r(0, 40, t), [], e.state, a, t);
    expect(e.alert?.level).toBe(AlertLevel.critical); // sans attendre le lendemain
    const again = evaluateAlert("w", r(0, 39, t), [], e.state, a, later(t, 3_600_000));
    expect(again.alert).toBeNull();
  });

  test("forecast_announces_six_days", () => {
    const now = new Date();
    // Perte de 5 Go par jour depuis une semaine, 30 Go libres sur 100 Go (au-dessus des seuils).
    const history: VolumeReading[] = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
      date: new Date(now.getTime() - d * 86_400_000),
      available: (30 + 5 * d) * GB,
      total: 100 * GB,
    }));
    const days = daysToFull([...history, { date: now, available: 30 * GB, total: 100 * GB }], now);
    expect(days).not.toBeNull();
    expect(Math.abs((days ?? 0) - 6)).toBeLessThan(0.5);
    const a = { ...alerts(), lowGB: 10, criticalGB: 1 };
    const e = evaluateAlert(
      "w",
      { date: now, available: 30 * GB, total: 100 * GB },
      history,
      initialAlertState(),
      a,
      now,
    );
    expect(e.alert?.daysToFull).not.toBeNull(); // alerte anticipée
    expect(e.alert?.daysToFull).toBeDefined();
    expect(daysToFull(history.slice(0, 2), now)).toBeNull(); // moins de 3 jours d'historique
  });

  test("snooze_for_seven_days", () => {
    const a = alerts();
    const now = new Date();
    const state = snooze(initialAlertState(), now);
    expect(evaluateAlert("w", r(0, 90, now), [], state, a, now).alert).toBeNull();
    const t = later(now, 8 * 86_400_000);
    expect(evaluateAlert("w", r(0, 90, t), [], state, a, t).alert).not.toBeNull();
  });

  test("history_persist_and_purge", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(dir);
      const h = emptyHistory();
      const now = new Date();
      addReading(h, "w", { date: new Date(now.getTime() - 40 * 86_400_000), available: 1, total: 2 });
      addReading(h, "w", { date: now, available: 1, total: 2 });
      expect(h.readings.w?.length).toBe(1); // relevés de plus de 30 jours purgés
      await saveHistory(h, paths);
      expect((await loadHistory(paths)).readings.w?.length).toBe(1);
    });
  });

  test("history_and_states_files_match_0_8_0", async () => {
    // Écrits par la 0.8.0 (JSONEncoder .iso8601, sans .sortedKeys : l'ordre des clés n'est pas significatif).
    const swiftHistory =
      '{"readings":{"workspaces":[{"total":494384795648,"available":27900522496,"date":"2026-11-08T22:13:36Z"}]}}';
    const h = decodeHistory(swiftHistory);
    expect(h.readings.workspaces?.[0]).toEqual({
      date: new Date("2026-11-08T22:13:36Z"),
      available: 27_900_522_496,
      total: 494_384_795_648,
    });
    expect(decodeHistory("garbage")).toEqual(emptyHistory());
    const states = decodeStates(
      '{"Macintosh HD":{"lastLevel":0},"workspaces":{"lastLevel":2,"lastNotified":"2026-11-08T22:13:36Z"}}',
    );
    expect(states["Macintosh HD"]).toEqual({ lastLevel: 0, lastNotified: null, snoozedUntil: null });
    expect(states.workspaces?.lastLevel).toBe(AlertLevel.critical);
    const s: Record<string, VolumeAlertState> = {
      w: { lastLevel: 1, lastNotified: new Date("2026-11-09T10:00:00.789Z"), snoozedUntil: null },
      x: initialAlertState(),
    };
    expect(encodeStates(s)).toBe('{"w":{"lastLevel":1,"lastNotified":"2026-11-09T10:00:00Z"},"x":{"lastLevel":0}}');
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(dir);
      const h2 = emptyHistory();
      addReading(h2, "w", { date: new Date("2026-11-09T10:00:00.5Z"), available: 5, total: 9 });
      await saveHistory(h2, paths);
      expect(await readFile(path.join(paths.state, "volumes.json"), "utf8")).toBe(
        '{"readings":{"w":[{"available":5,"date":"2026-11-09T10:00:00Z","total":9}]}}',
      );
      await snoozeVolume("w", paths, new Date("2026-11-09T10:00:00Z"));
      expect((await loadAlertStates(paths)).w?.snoozedUntil).toEqual(new Date("2026-11-16T10:00:00Z"));
    });
  });

  test("check_records_volumes_once_and_notifies", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(path.join(dir, "cairn"));
      const info: VolumeInfo = { name: "w", total: 1000 * GB, available: 95 * GB, availableImportant: 90 * GB };
      const readVolume = async () => info;
      const now = new Date("2026-11-09T10:00:00Z");
      const opts = { paths, folders: [dir, dir, path.join(dir, "absent")], alerts: alerts(), readVolume, now };
      const first = await checkStorage(opts);
      expect(first.notify.map((a) => [a.volume, a.level, a.available])).toEqual([["w", AlertLevel.low, 90 * GB]]);
      expect(first.active.length).toBe(1);
      expect((await loadHistory(paths)).readings.w?.length).toBe(1); // deux dossiers, un volume
      // Une heure plus tard : toujours affichée, pas renotifiée.
      const second = await checkStorageAfterBackup({ ...opts, now: new Date("2026-11-09T11:00:00Z") });
      expect(second.notify).toEqual([]);
      expect(second.active.length).toBe(1);
      expect((await loadAlertStates(paths)).w?.lastNotified).toEqual(now);
    });
  });

  test("volume_info_uses_native_important_capacity", async () => {
    setNative({ volumeImportantCapacity: () => 123_456 } as unknown as NativeBinding);
    const v = await volumeInfo(os.homedir());
    expect(v?.availableImportant).toBe(123_456);
    expect(v?.total).toBeGreaterThan(0);
    expect(v?.name.length).toBeGreaterThan(0);
    // Sans module natif : repli sur l'espace disponible.
    setNative(null);
    const fallback = await volumeInfo(os.homedir());
    expect(fallback?.availableImportant).toBe(fallback?.available ?? -1);
    expect(await volumeInfo("/nonexistent-cairn")).toBeNull();
  });

  test("volume_name_of_mounted_volume", async () => {
    setNative(null);
    if (existsSync("/Volumes/workspaces")) {
      expect((await volumeInfo("/Volumes/workspaces/exports"))?.name).toBe("workspaces");
    }
    // Le home (volume de données, monté sous /System/Volumes/Data) porte le nom du volume de démarrage.
    const root = await volumeInfo("/");
    expect(root?.name).not.toBe("");
    expect((await volumeInfo(os.homedir()))?.name).toBe(root?.name ?? "");
  });
});
