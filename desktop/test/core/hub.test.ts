// Accueil (port des cas `HubState` et `HubRecord` de HubTests.swift ; les cas du journal d'activité sont dans
// activity-log.test.ts, `full_check_git_options…` dans les tests git, `backup_service_logs_activity` côté sauvegarde).
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScheduleConfig } from "../../src/core/config.ts";
import { destinationHealth, type HealthLevel, worstLevel } from "../../src/core/health.ts";
import {
  type HubDestination,
  type HubInputs,
  hubInputs,
  hubIssues,
  hubModule,
  hubOverall,
  loadHubRecord,
  makeHubState,
  saveHubRecord,
  type VolumeAlert,
} from "../../src/core/hub-state.ts";
import { utcCalendar } from "../../src/core/schedule/calendar.ts";
import { AlertLevel } from "../../src/core/storage-alerts.ts";

const now = new Date("2026-11-08T10:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000);

function alert(volume: string, level: AlertLevel): VolumeAlert {
  return { volume, level, available: 5_000_000_000 };
}

function dest(
  id: string,
  o: { success?: Date; error?: string; waitingSince?: Date; waiting?: boolean; damaged?: string[] } = {},
): HubDestination {
  return {
    id,
    label: id,
    state: {
      lastSuccess: o.success ?? null,
      lastError: o.error ?? null,
      waitingSince: o.waitingSince ?? null,
      damagedVersions: o.damaged ?? [],
    },
    waiting: o.waiting ?? false,
  };
}

function inputs(change: (i: HubInputs) => void = () => {}): HubInputs {
  const i = hubInputs({ now, calendar: utcCalendar });
  i.schedule = { ...i.schedule, frequency: "manual" };
  change(i);
  return i;
}

/** Règle de l'icône de la barre des menus telle qu'elle était écrite dans `AppModel.globalStatus` avant le hub. */
function referenceStatus(i: HubInputs): HealthLevel {
  if (i.configErrors.length > 0) return "error";
  const backup = worstLevel(
    i.destinations.map((d) => destinationHealth(d.state, d.waiting, i.schedule, i.now, i.calendar)),
  );
  if (backup === "error") return "error";
  if (backup === "attention" || i.volumeAlerts.length > 0 || i.unavailableFolders.length > 0) return "attention";
  return "ok";
}

describe("hub", () => {
  test("priority_order_follows_spec", () => {
    const i = inputs((i) => {
      i.volumeAlerts = [alert("Data", AlertLevel.low), alert("Macintosh HD", AlertLevel.critical)];
      i.unavailableFolders = ["/Volumes/Missing/work"];
      i.destinations = [dest("nas", { waitingSince: ago(30), waiting: true }), dest("usb", { error: "rsync failed" })];
      i.configErrors = ["error line 4: syntax"];
    });
    expect(hubIssues(i).map((x) => x.kind)).toEqual([
      "configInvalid",
      "backupFailed",
      "diskCritical",
      "destinationOverdue",
      "diskLow",
      "folderUnavailable",
    ]);
    expect(makeHubState(i).topIssue?.kind).toBe("configInvalid");
  });

  test("versions damaged come last", () => {
    const i = inputs((i) => {
      i.unavailableFolders = ["/Volumes/Missing/work"];
      i.destinations = [dest("nas", { success: now, damaged: ["v1", "v2"] })];
    });
    const issues = hubIssues(i);
    expect(issues.map((x) => x.kind)).toEqual(["folderUnavailable", "versionsDamaged"]);
    expect(issues[0]!.subject).toBe("work");
    expect(issues[1]!.bytes).toBe(2);
  });

  test("top_issue_backup_failed_over_disk_low", () => {
    const h = makeHubState(
      inputs((i) => {
        i.volumeAlerts = [alert("Macintosh HD", AlertLevel.low)];
        i.destinations = [dest("syno", { error: "unreachable share" })];
      }),
    );
    expect(h.topIssue?.kind).toBe("backupFailed");
    expect(h.topIssue?.ref).toBe("syno");
    // L'alerte de disque reste visible sur la carte Stockage.
    expect(hubModule(h, "storage").tone).toBe("attention");
    expect(h.overall).toBe("error");
  });

  test("two_attention_points", () => {
    const h = makeHubState(
      inputs((i) => {
        i.volumeAlerts = [alert("Macintosh HD", AlertLevel.low)];
        i.destinations = [dest("nas", { success: ago(40), waitingSince: ago(30), waiting: true })];
      }),
    );
    expect(h.overall).toBe("attention");
    expect(h.causes.map((x) => x.kind)).toEqual(["destinationOverdue", "diskLow"]);
  });

  test("config_invalid_keeps_line", () => {
    const h = makeHubState(
      inputs((i) => {
        i.configErrors = ["Erreur ligne 12 : syntaxe"];
      }),
    );
    expect(h.overall).toBe("error");
    expect(h.topIssue?.detail).toBe("Erreur ligne 12 : syntaxe");
  });

  test("all_in_order", () => {
    const h = makeHubState(
      inputs((i) => {
        i.destinations = [dest("nas", { success: ago(3) })];
      }),
    );
    expect(h.overall).toBe("ok");
    expect(h.causes).toEqual([]);
    expect(h.topIssue).toBeNull(); // aucun bandeau attendu
  });

  test("overall_matches_menu_bar_status", () => {
    const destinations: HubDestination[][] = [
      [],
      [dest("a", { success: now })],
      [dest("a", { error: "x" })],
      [dest("a", { damaged: ["v1"] })],
      [dest("a", { waiting: true })],
      [dest("a", { waitingSince: new Date(now.getTime() - 90_000_000), waiting: true })],
      [dest("a", { success: now }), dest("b", { error: "x" })],
    ];
    let checked = 0;
    for (const d of destinations) {
      for (const config of [[], ["error"]]) {
        for (const alerts of [[], [alert("v", AlertLevel.low)], [alert("v", AlertLevel.critical)]]) {
          for (const folders of [[], ["/missing"]]) {
            for (const frequency of ["manual", "daily"] as ScheduleConfig["frequency"][]) {
              const i = inputs((i) => {
                i.destinations = d;
                i.configErrors = config;
                i.volumeAlerts = alerts;
                i.unavailableFolders = folders;
                i.schedule = { ...i.schedule, frequency };
              });
              expect(makeHubState(i).overall).toBe(referenceStatus(i));
              expect(hubOverall(i)).toBe(referenceStatus(i));
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("module_no_destination", () => {
    const b = hubModule(makeHubState(inputs()), "backup");
    expect(b.tone).toBe("attention");
    expect(b.figure).toEqual({ kind: "noDestination" });
    expect(b.action).toBe("addDestination");
  });

  test("module_backup_success", () => {
    const last = ago(3);
    const h = makeHubState(
      inputs((i) => {
        i.schedule = { ...i.schedule, frequency: "daily", time: "12:30" };
        i.destinations = [dest("nas", { success: last })];
      }),
    );
    const b = hubModule(h, "backup");
    expect(b.tone).toBe("ok");
    expect(b.figure).toEqual({ kind: "lastBackup", date: last });
    expect(b.action).toBe("backupNow");
    expect(b.detail.kind).toBe("nextBackup");
    if (b.detail.kind === "nextBackup") expect(b.detail.date.getTime()).toBeGreaterThan(now.getTime());
    expect(hubModule(h, "restore").figure).toEqual({ kind: "lastVersion", date: last });
  });

  test("module_backup_failed", () => {
    const b = hubModule(
      makeHubState(
        inputs((i) => {
          i.destinations = [dest("nas", { success: ago(24), error: "boom" })];
        }),
      ),
      "backup",
    );
    expect(b.tone).toBe("error");
    expect(b.figure).toEqual({ kind: "failed", label: "nas" });
    expect(b.action).toBe("openBackup");
  });

  test("module_unreachable_destination", () => {
    const b = hubModule(
      makeHubState(
        inputs((i) => {
          i.destinations = [dest("NAS", { success: now, waiting: true })];
        }),
      ),
      "backup",
    );
    expect(b.figure).toEqual({ kind: "unreachable", label: "NAS" });
    expect(b.tone).toBe("info");
  });

  test("module_git_never_analyzed", () => {
    const g = hubModule(makeHubState(inputs()), "git");
    expect(g.figure).toEqual({ kind: "notAnalyzed" });
    expect(g.action).toBe("analyzeGit");
    expect(g.tone).toBe("unknown");
    expect(
      hubModule(
        makeHubState(
          inputs((i) => {
            i.git = { candidates: 0, bytes: 0 };
          }),
        ),
        "git",
      ).figure,
    ).toEqual({
      kind: "gitClean",
    });
    const some = hubModule(
      makeHubState(
        inputs((i) => {
          i.git = { candidates: 3, bytes: 10 };
        }),
      ),
      "git",
    );
    expect(some).toMatchObject({ tone: "info", figure: { kind: "gitCandidates", count: 3 }, action: "openGit" });
  });

  test("module_storage", () => {
    expect(hubModule(makeHubState(inputs()), "storage").action).toBe("analyze");
    const s = hubModule(
      makeHubState(
        inputs((i) => {
          i.freeBytes = 100_000_000_000;
          i.summary = {
            date: now,
            totalBytes: 1,
            reclaimableByType: { deps: 12_000_000_000 },
            obsoleteWorktreeBytes: 0,
            trashBytes: 0,
          };
        }),
      ),
      "storage",
    );
    expect(s.figure).toEqual({ kind: "free", bytes: 100_000_000_000 });
    expect(s.detail).toEqual({ kind: "reclaimable", bytes: 12_000_000_000 });
    expect(s.action).toBe("clean");
    expect(s.tone).toBe("ok");
  });

  test("module_ai_and_restore", () => {
    const h = makeHubState(
      inputs((i) => {
        i.aiDetected = 2;
        i.destinations = [dest("nas", { success: ago(3), damaged: ["v1"] })];
        i.versions = { nas: 12 };
      }),
    );
    expect(hubModule(h, "ai")).toMatchObject({ tone: "ok", figure: { kind: "aiTools", count: 2 }, action: "viewAI" });
    expect(hubModule(h, "restore")).toMatchObject({
      tone: "attention",
      figure: { kind: "versions", count: 12 },
      detail: { kind: "damaged", count: 1 },
    });
  });

  test("hub_record_round_trip", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-hub-"));
    const state = path.join(dir, "state");
    expect((await loadHubRecord(state)).lastCheck).toBeNull();
    await saveHubRecord(state, { lastCheck: now });
    expect((await loadHubRecord(state)).lastCheck).toEqual(now);
    // Format de la 0.8.0 : JSONEncoder compact, date sans millisecondes.
    expect(await readFile(path.join(state, "hub.json"), "utf8")).toBe('{"lastCheck":"2026-11-08T10:00:00Z"}');
  });
});
