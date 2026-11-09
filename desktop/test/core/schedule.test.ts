// Planification (port des cas `schedule_decisions` et `overdue_notification_after_one_day_once_per_day` de
// BackupTests.swift, et de `next_backup_schedule` de StorageWarningTests.swift) : horloge et calendrier simulés.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dateOfVersion } from "../../src/core/backup/versions.ts";
import { defaultConfig, type ScheduleConfig } from "../../src/core/config.ts";
import { localCalendar, utcCalendar } from "../../src/core/schedule/calendar.ts";
import { parseBattery, parseLowPowerMode } from "../../src/core/schedule/power.ts";
import {
  AC_POWER,
  decide,
  lastOccurrence,
  nextBackup,
  type Power,
  shouldNotifyOverdue,
} from "../../src/core/schedule/schedule.ts";
import { fileRunStatePort, planTick, recordOverdueNotices } from "../../src/core/schedule/tick.ts";

const at = (name: string): Date => dateOfVersion(name)!;

function schedule(change: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return { ...defaultConfig().schedule, ...change };
}

describe("schedule", () => {
  test("schedule_decisions", () => {
    const s = schedule({ frequency: "daily", time: "12:00" });
    const cal = localCalendar;
    const base = { running: false, power: AC_POWER, reachable: true, calendar: cal };
    expect(decide(s, { ...base, lastSuccess: at("2026-11-07T120500"), now: at("2026-11-08T110000") })).toBe("notDue");
    // échéance de midi manquée → rattrapage
    expect(decide(s, { ...base, lastSuccess: at("2026-11-07T120500"), now: at("2026-11-08T150000") })).toBe("run");
    expect(decide(s, { ...base, lastSuccess: null, now: at("2026-11-08T150000"), running: true })).toBe(
      "alreadyRunning",
    );
    const battery: Power = { onBattery: true, percent: 15, lowPowerMode: false };
    expect(decide(s, { ...base, lastSuccess: null, now: at("2026-11-08T150000"), power: battery })).toBe(
      "waitingPower",
    );
    expect(decide(s, { ...base, lastSuccess: null, now: at("2026-11-08T150000"), reachable: false })).toBe(
      "waitingDestination",
    );
    // échec il y a 20 min → pas de relance
    expect(
      decide(s, { ...base, lastSuccess: null, lastFailure: at("2026-11-08T144000"), now: at("2026-11-08T150000") }),
    ).toBe("retryLater");
    // échec il y a plus d'une heure → relance
    expect(
      decide(s, { ...base, lastSuccess: null, lastFailure: at("2026-11-08T135000"), now: at("2026-11-08T150000") }),
    ).toBe("run");
    // échec antérieur à la dernière réussite → pas de délai
    expect(
      decide(s, {
        ...base,
        lastSuccess: at("2026-11-07T120500"),
        lastFailure: at("2026-11-06T120500"),
        now: at("2026-11-08T150000"),
      }),
    ).toBe("run");
    const w = { ...s, frequency: "weekly" as const, weekday: "monday" }; // 2026-11-09 est un lundi
    expect(decide(w, { ...base, lastSuccess: at("2026-11-02T130000"), now: at("2026-11-08T150000") })).toBe("notDue");
    expect(decide(w, { ...base, lastSuccess: at("2026-11-02T130000"), now: at("2026-11-09T150000") })).toBe("run");
    expect(decide({ ...s, frequency: "manual" }, { ...base, lastSuccess: null, now: at("2026-11-08T150000") })).toBe(
      "manual",
    );
  });

  test("power rules: low power mode and battery threshold", () => {
    const s = schedule({ frequency: "daily", time: "12:00", onBatteryMinPercent: 20 });
    const base = { lastSuccess: null, now: at("2026-11-08T150000"), running: false, reachable: true };
    expect(decide(s, { ...base, power: { onBattery: true, percent: 80, lowPowerMode: true } })).toBe("waitingPower");
    expect(decide(s, { ...base, power: { onBattery: true, percent: 20, lowPowerMode: false } })).toBe("run");
    // Sur secteur, le mode économie d'énergie ne bloque pas.
    expect(decide(s, { ...base, power: { onBattery: false, percent: 5, lowPowerMode: true } })).toBe("run");
  });

  test("overdue_notification_after_one_day_once_per_day", () => {
    const s = schedule({ time: "12:00" });
    const last = at("2026-11-06T120500");
    // 3 h de retard : pas de notification
    expect(shouldNotifyOverdue(s, last, null, at("2026-11-07T150000"), localCalendar)).toBe(false);
    // 30 h de retard
    expect(shouldNotifyOverdue(s, last, null, at("2026-11-08T180000"), localCalendar)).toBe(true);
    // une par jour au plus
    expect(shouldNotifyOverdue(s, last, at("2026-11-08T100000"), at("2026-11-08T180000"), localCalendar)).toBe(false);
  });

  test("next_backup_schedule", () => {
    const cal = utcCalendar;
    const day = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 2, d, h, m));
    const s = schedule({ frequency: "daily", time: "12:30" });
    // Sauvegardé hier après l'échéance : prochaine aujourd'hui 12:30.
    expect(nextBackup(s, day(9, 13), day(10, 10), cal)).toEqual(day(10, 12, 30));
    // Jamais sauvegardé : échéance déjà passée (en retard).
    const overdue = nextBackup(s, null, day(10, 10), cal);
    expect(overdue).not.toBeNull();
    expect(overdue!.getTime()).toBeLessThanOrEqual(day(10, 10).getTime());
    const w = { ...s, frequency: "weekly" as const, weekday: "monday" }; // 2026-03-09 est un lundi
    expect(nextBackup(w, day(9, 13), day(11, 10), cal)).toEqual(day(16, 12, 30));
    expect(nextBackup({ ...s, frequency: "manual" }, null, day(10, 10), cal)).toBeNull();
  });

  test("weekly occurrence uses Foundation weekdays (sunday = 1)", () => {
    const s = schedule({ frequency: "weekly", weekday: "sunday", time: "09:00" });
    // 2026-03-11 est un mercredi : dernier dimanche 2026-03-08.
    expect(lastOccurrence(s, new Date(Date.UTC(2026, 2, 11, 10)), utcCalendar)).toEqual(
      new Date(Date.UTC(2026, 2, 8, 9)),
    );
    expect(lastOccurrence({ ...s, time: "9h" }, new Date(), utcCalendar)).toBeNull();
  });

  test("pmset output parsing", () => {
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;")).toEqual({
      onBattery: false,
      percent: 100,
    });
    expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t15%; discharging;")).toEqual({
      onBattery: true,
      percent: 15,
    });
    expect(parseBattery("Now drawing from 'AC Power'\n")).toEqual({ onBattery: false, percent: 100 });
    expect(parseLowPowerMode("Currently in use:\n standby 1\n powermode            0\n")).toBe(false);
    expect(parseLowPowerMode("Currently in use:\n lowpowermode         1\n")).toBe(true);
    expect(parseLowPowerMode(" powermode            1\n")).toBe(true);
    expect(parseLowPowerMode(" powermode            2\n")).toBe(false);
  });

  test("tick: due and waiting destinations, invalid config blocks everything", () => {
    const s = schedule({ frequency: "daily", time: "12:00" });
    const input = {
      destinationIds: ["nas", "usb"],
      schedule: s,
      state: { usb: { lastSuccess: at("2026-11-08T130000") } },
      reachable: { nas: false, usb: true },
      power: AC_POWER,
      now: at("2026-11-08T150000"),
      running: false,
      configInvalid: false,
      calendar: localCalendar,
    };
    const plan = planTick(input);
    expect(plan.due).toEqual([]);
    expect(plan.waiting).toEqual({ nas: true, usb: false });
    expect(plan.decisions).toEqual({ nas: "waitingDestination", usb: "notDue" });
    expect(planTick({ ...input, reachable: { nas: true, usb: true } }).due).toEqual(["nas"]);
    expect(planTick({ ...input, reachable: { nas: true }, configInvalid: true }).due).toEqual([]);
  });

  test("overdue notices are written to runs.json for waiting destinations only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-schedule-"));
    const paths = { state: path.join(dir, "state") };
    const port = fileRunStatePort(paths);
    await port.update((s) => {
      s.entry("nas").lastSuccess = at("2026-11-06T120500");
      s.entry("usb").lastSuccess = at("2026-11-06T120500");
      return true;
    });
    const notified: string[] = [];
    const input = {
      schedule: schedule({ time: "12:00" }),
      waiting: { nas: true, usb: false },
      now: at("2026-11-08T180000"),
      calendar: localCalendar,
    };
    expect(await recordOverdueNotices(port, input, (id) => notified.push(id))).toEqual(["nas"]);
    expect(notified).toEqual(["nas"]);
    const raw = JSON.parse(await readFile(path.join(paths.state, "runs.json"), "utf8"));
    expect(raw.destinations.nas.lastOverdueNotice).toBe(input.now.toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(raw.destinations.usb.lastOverdueNotice).toBeUndefined();
    // Une notice par jour au plus.
    expect(await recordOverdueNotices(port, { ...input, now: at("2026-11-08T200000") }, () => {})).toEqual([]);
  });
});
