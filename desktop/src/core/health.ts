// État global affiché par la barre des menus (port de `Health`, Health.swift) : décisions pures, horloge simulée.
import type { ScheduleConfig } from "./config.ts";
import { type Calendar, localCalendar } from "./schedule/calendar.ts";
import { nextBackup as scheduleNextBackup, shouldNotifyOverdue } from "./schedule/schedule.ts";

export type HealthLevel = "ok" | "attention" | "error";

const RANK: Record<HealthLevel, number> = { ok: 0, attention: 1, error: 2 };

export function compareLevels(a: HealthLevel, b: HealthLevel): number {
  return RANK[a] - RANK[b];
}

/** Niveau le plus grave (`ok` pour une liste vide). */
export function worstLevel(levels: Iterable<HealthLevel>): HealthLevel {
  let worst: HealthLevel = "ok";
  for (const l of levels) if (RANK[l] > RANK[worst]) worst = l;
  return worst;
}

/** Champs de `runs.json` utilisés pour la santé d'une destination (modèle complet dans `src/core/backup`). */
export interface DestinationStatus {
  lastSuccess?: Date | null;
  lastError?: string | null;
  /** Destination injoignable depuis. */
  waitingSince?: Date | null;
  damagedVersions?: readonly string[];
}

const DAY_MS = 86_400 * 1000;

/**
 * Une destination : erreur si la dernière sauvegarde a échoué ; attention si des versions sont abîmées ou si elle est
 * injoignable depuis plus d'un jour (ou avec une échéance manquée depuis plus d'un jour).
 */
export function destinationHealth(
  ds: DestinationStatus,
  waiting: boolean,
  schedule: ScheduleConfig,
  now: Date,
  calendar: Calendar = localCalendar,
): HealthLevel {
  if (ds.lastError !== undefined && ds.lastError !== null) return "error";
  if ((ds.damagedVersions?.length ?? 0) > 0) return "attention";
  if (!waiting && !ds.waitingSince) return "ok";
  if (ds.waitingSince && now.getTime() - ds.waitingSince.getTime() > DAY_MS) return "attention";
  if (shouldNotifyOverdue(schedule, ds.lastSuccess, null, now, calendar)) return "attention";
  return "ok";
}

/** Prochaine échéance de sauvegarde (`null` en manuel). Une échéance déjà passée signifie « en retard ». */
export const nextBackup = scheduleNextBackup;

/** La dernière analyse date de plus de `days` jours (ou n'a jamais eu lieu). */
export function analysisIsStale(date: Date | null | undefined, now: Date, days = 7): boolean {
  if (!date) return true;
  return now.getTime() - date.getTime() > days * DAY_MS;
}
