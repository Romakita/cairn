// Santé des destinations et de l'analyse (port de `destination_health_levels` et `analysis_staleness`,
// StorageWarningTests.swift ; `next_backup_schedule` est dans schedule.test.ts).
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/core/config.ts";
import { analysisIsStale, type DestinationStatus, destinationHealth, worstLevel } from "../../src/core/health.ts";

const DAY = 86_400_000;

describe("health", () => {
  test("destination_health_levels", () => {
    const now = new Date();
    const s = defaultConfig().schedule;
    const ds: DestinationStatus = { lastSuccess: new Date(now.getTime() - 3600_000), damagedVersions: [] };
    expect(destinationHealth(ds, false, s, now)).toBe("ok");
    expect(destinationHealth(ds, true, s, now)).toBe("ok"); // injoignable depuis peu : rien
    ds.waitingSince = new Date(now.getTime() - 2 * DAY);
    expect(destinationHealth(ds, true, s, now)).toBe("attention"); // en attente depuis plus d'un jour
    ds.waitingSince = null;
    ds.lastSuccess = new Date(now.getTime() - 5 * DAY);
    expect(destinationHealth(ds, true, s, now)).toBe("attention"); // échéance manquée depuis plus d'un jour
    ds.lastError = "boom";
    expect(destinationHealth(ds, false, s, now)).toBe("error");
    expect(destinationHealth({ damagedVersions: ["v1"] }, false, s, now)).toBe("attention");
  });

  test("analysis_staleness", () => {
    const now = new Date();
    expect(analysisIsStale(null, now)).toBe(true);
    expect(analysisIsStale(new Date(now.getTime() - 8 * DAY), now)).toBe(true);
    expect(analysisIsStale(new Date(now.getTime() - 6 * DAY), now)).toBe(false);
  });

  test("worst level", () => {
    expect(worstLevel([])).toBe("ok");
    expect(worstLevel(["ok", "attention"])).toBe("attention");
    expect(worstLevel(["attention", "error", "ok"])).toBe("error");
  });
});
