// Décisions de planification (port de `BackupSchedule`, Scheduler.swift) : fonctions pures, horloge et calendrier
// injectés. Ordre des décisions (parity/behavior.md §1.1) : manual, notDue, alreadyRunning, retryLater,
// waitingPower, waitingDestination, run.
import { type ScheduleConfig, WEEKDAYS } from "../config.ts";
import { addDays, type Calendar, localCalendar } from "./calendar.ts";

export type ScheduleDecision =
  | "run"
  | "notDue"
  | "manual"
  | "alreadyRunning"
  | "waitingPower"
  | "waitingDestination"
  /** Dernier échec trop récent : on attend `RETRY_DELAY_MS` avant de relancer. */
  | "retryLater";

/** Délai avant de relancer automatiquement une sauvegarde qui a échoué (évite une boucle de relances). */
export const RETRY_DELAY_MS = 3600 * 1000;
const DAY_MS = 86_400 * 1000;

export interface Power {
  onBattery: boolean;
  percent: number;
  lowPowerMode: boolean;
}

/** Sur secteur. */
export const AC_POWER: Readonly<Power> = Object.freeze({ onBattery: false, percent: 100, lowPowerMode: false });

/** `HH:MM` → [heure, minute], ou `null` (comme `split(":").compactMap { Int($0) }` avec deux nombres). */
function parseTime(time: string): [number, number] | null {
  const parts = time.split(":");
  const numbers = parts.filter((p) => /^[+-]?\d+$/.test(p)).map(Number);
  if (numbers.length !== 2) return null;
  return [numbers[0]!, numbers[1]!];
}

/** Dernière échéance prévue au plus tard à `now` (`null` en manuel). */
export function lastOccurrence(s: ScheduleConfig, now: Date, calendar: Calendar = localCalendar): Date | null {
  if (s.frequency === "manual") return null;
  const time = parseTime(s.time);
  if (!time) return null;
  const today = calendar.parts(now);
  let candidate = calendar.date({
    year: today.year,
    month: today.month,
    day: today.day,
    hour: time[0],
    minute: time[1],
  });
  if (s.frequency === "daily") {
    if (candidate > now) candidate = addDays(calendar, candidate, -1);
    return candidate;
  }
  // Hebdomadaire : remonter jusqu'au bon jour (Calendar : dimanche = 1, lundi = 2).
  const index = (WEEKDAYS as readonly string[]).indexOf(s.weekday);
  const target = Math.max(index, 0) + 2;
  const wanted = target > 7 ? 1 : target;
  for (let i = 0; i < 8; i++) {
    if (calendar.parts(candidate).weekday === wanted && candidate <= now) return candidate;
    candidate = addDays(calendar, candidate, -1);
  }
  return null;
}

/** Une échéance est due si la dernière réussite précède la dernière échéance prévue. */
export function isDue(
  s: ScheduleConfig,
  lastSuccess: Date | null | undefined,
  now: Date,
  calendar: Calendar = localCalendar,
): boolean {
  const occ = lastOccurrence(s, now, calendar);
  if (!occ) return false;
  return lastSuccess ? lastSuccess < occ : true;
}

export interface DecideInput {
  lastSuccess?: Date | null;
  lastFailure?: Date | null;
  now: Date;
  running: boolean;
  power: Power;
  reachable: boolean;
  calendar?: Calendar;
}

/** Décision du planificateur pour une destination (les règles d'alimentation ne valent que pour lui). */
export function decide(s: ScheduleConfig, input: DecideInput): ScheduleDecision {
  const { lastSuccess, lastFailure, now, running, power, reachable } = input;
  if (s.frequency === "manual") return "manual";
  if (!isDue(s, lastSuccess, now, input.calendar)) return "notDue";
  if (running) return "alreadyRunning";
  // Un échec antérieur à la dernière réussite n'ajoute pas de délai (7cc955d).
  if (lastFailure && lastFailure.getTime() > (lastSuccess?.getTime() ?? Number.NEGATIVE_INFINITY)) {
    if (now.getTime() - lastFailure.getTime() < RETRY_DELAY_MS) return "retryLater";
  }
  if (power.onBattery && (power.lowPowerMode || power.percent < s.onBatteryMinPercent)) return "waitingPower";
  if (!reachable) return "waitingDestination";
  return "run";
}

/**
 * Retard d'une destination : notification quand la plus ancienne échéance manquée depuis la dernière réussite date
 * de plus d'un jour, puis au plus une par jour (`lastNotice`).
 */
export function shouldNotifyOverdue(
  s: ScheduleConfig,
  lastSuccess: Date | null | undefined,
  lastNotice: Date | null | undefined,
  now: Date,
  calendar: Calendar = localCalendar,
): boolean {
  const occ = lastOccurrence(s, now, calendar);
  if (!occ || (lastSuccess && lastSuccess >= occ)) return false;
  // Retard = depuis l'échéance manquée la plus ancienne (après la dernière réussite).
  let oldest = occ;
  if (lastSuccess) {
    let probe = new Date(occ.getTime() - 1000);
    for (;;) {
      const prev = lastOccurrence(s, probe, calendar);
      if (!prev || prev <= lastSuccess) break;
      oldest = prev;
      probe = new Date(prev.getTime() - 1000);
    }
  }
  if (now.getTime() - oldest.getTime() <= DAY_MS) return false;
  return lastNotice ? now.getTime() - lastNotice.getTime() >= DAY_MS : true;
}

/** Prochaine échéance (`null` en manuel). Une échéance déjà passée signifie « en retard » (port de `Health.nextBackup`). */
export function nextBackup(
  s: ScheduleConfig,
  lastSuccess: Date | null | undefined,
  now: Date,
  calendar: Calendar = localCalendar,
): Date | null {
  const last = lastOccurrence(s, now, calendar);
  if (!last) return null;
  if (isDue(s, lastSuccess, now, calendar)) return last;
  return addDays(calendar, last, s.frequency === "weekly" ? 7 : 1);
}
