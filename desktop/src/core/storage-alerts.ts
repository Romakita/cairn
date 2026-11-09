// Alertes de disque plein (port de StorageAlerts.swift, `VolumeHistory`, `Scanner.volumeInfo` et du relevé de
// `StorageMonitor.check`, MenuBarPanel.swift). Décisions pures + relevé qui lit seulement la capacité des volumes.
// Fichiers : `state/volumes.json` (relevés, 30 jours) et `state/alerts.json` (anti-harcèlement), mêmes formats que la
// 0.8.0 (dates ISO 8601 à la seconde, niveau entier).
import { readdir, readFile, readlink, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./analysis.ts";
import type { AlertsConfig } from "./config.ts";
import { isoDate, parseISODate } from "./dates.ts";
import { compactJSON, type JSONValue } from "./json.ts";
import { native } from "./native.ts";
import type { CairnPaths } from "./paths.ts";
import { expandTilde } from "./paths.ts";

const DAY = 86_400_000;
const GB = 1_000_000_000;

// MARK: Volume

export interface VolumeInfo {
  name: string;
  total: number;
  available: number;
  /** Espace libre « pour usage important » (purgeable APFS compris), repli sur `available`. */
  availableImportant: number;
}

/** Point de montage d'un chemin : on remonte tant que le volume (`st_dev`) ne change pas. */
async function mountPoint(p: string): Promise<string> {
  let current = path.resolve(p);
  const dev = (await stat(current)).dev;
  while (current !== "/") {
    const parent = path.dirname(current);
    const parentDev = await stat(parent).then(
      (s) => s.dev,
      () => -1,
    );
    if (parentDev !== dev) return current;
    current = parent;
  }
  return "/";
}

/** Nom du volume de démarrage : le lien de `/Volumes` qui pointe sur `/` (« Macintosh HD »). */
async function startupVolumeName(): Promise<string> {
  try {
    for (const entry of await readdir("/Volumes")) {
      const target = await readlink(path.join("/Volumes", entry)).catch(() => null);
      if (target === "/") return entry;
    }
  } catch {
    // pas de /Volumes lisible : repli
  }
  return "Macintosh HD";
}

/**
 * Nom du volume d'un chemin (`volumeNameKey`) : nom du point de montage sous `/Volumes`, sinon le volume de démarrage
 * (y compris le volume de données monté sous `/System/Volumes/Data`). Un volume monté sous un autre nom que le sien
 * (« Cairn 1 ») prend le nom de son point de montage.
 */
export async function volumeName(p: string): Promise<string> {
  const mount = await mountPoint(p);
  if (mount.startsWith("/Volumes/")) return path.basename(mount);
  return startupVolumeName();
}

export type VolumeReader = (folder: string) => Promise<VolumeInfo | null>;

/** Capacité du volume qui contient `p` (`Scanner.volumeInfo`), ou `null` s'il est inaccessible. */
export async function volumeInfo(p: string): Promise<VolumeInfo | null> {
  try {
    const target = expandTilde(p);
    const fs = await statfs(target);
    const total = fs.blocks * fs.bsize;
    const available = fs.bavail * fs.bsize;
    let important: number | null = null;
    try {
      important = native().volumeImportantCapacity(target);
    } catch {
      important = null; // module natif absent : repli sur l'espace disponible
    }
    return { name: await volumeName(target), total, available, availableImportant: important ?? available };
  } catch {
    return null;
  }
}

// MARK: Historique des relevés

export interface VolumeReading {
  date: Date;
  available: number;
  total: number;
}

/** Relevés de capacité par nom de volume (`state/volumes.json`), gardés 30 jours. */
export interface VolumeHistory {
  readings: Record<string, VolumeReading[]>;
}

export function emptyHistory(): VolumeHistory {
  return { readings: {} };
}

export function addReading(history: VolumeHistory, volume: string, r: VolumeReading, keepDays = 30): void {
  const list = [...(history.readings[volume] ?? []), r];
  const limit = r.date.getTime() - keepDays * DAY;
  history.readings[volume] = list.filter((x) => x.date.getTime() >= limit);
}

function historyFile(paths: CairnPaths): string {
  return path.join(paths.state, "volumes.json");
}

function alertsFile(paths: CairnPaths): string {
  return path.join(paths.state, "alerts.json");
}

export function encodeHistory(h: VolumeHistory): string {
  const readings: Record<string, JSONValue> = {};
  for (const [volume, list] of Object.entries(h.readings)) {
    readings[volume] = list.map((r) => ({ date: isoDate(r.date), available: r.available, total: r.total }));
  }
  return compactJSON({ readings });
}

/** Historique lu ; un fichier absent ou illisible donne un historique vide (comme la 0.8.0). */
export function decodeHistory(text: string): VolumeHistory {
  try {
    const raw = JSON.parse(text) as { readings?: unknown };
    if (typeof raw?.readings !== "object" || raw.readings === null) return emptyHistory();
    const out = emptyHistory();
    for (const [volume, list] of Object.entries(raw.readings as Record<string, unknown>)) {
      if (!Array.isArray(list)) return emptyHistory();
      const readings: VolumeReading[] = [];
      for (const item of list) {
        const r = item as Record<string, unknown>;
        const date = typeof r.date === "string" ? parseISODate(r.date) : null;
        if (!date || typeof r.available !== "number" || typeof r.total !== "number") return emptyHistory();
        readings.push({ date, available: r.available, total: r.total });
      }
      out.readings[volume] = readings;
    }
    return out;
  } catch {
    return emptyHistory();
  }
}

export async function loadHistory(paths: CairnPaths): Promise<VolumeHistory> {
  try {
    return decodeHistory(await readFile(historyFile(paths), "utf8"));
  } catch {
    return emptyHistory();
  }
}

export async function saveHistory(h: VolumeHistory, paths: CairnPaths): Promise<void> {
  await paths.prepare(paths.state);
  await writeAtomic(historyFile(paths), encodeHistory(h));
}

// MARK: Décisions

export const AlertLevel = { ok: 0, low: 1, critical: 2 } as const;
export type AlertLevel = (typeof AlertLevel)[keyof typeof AlertLevel];

export interface StorageAlert {
  volume: string;
  level: AlertLevel;
  available: number;
  percentFree: number;
  /** Jours avant remplissage au rythme des 7 derniers jours (alerte anticipée). */
  daysToFull: number | null;
}

/** État anti-harcèlement par volume (`state/alerts.json`). */
export interface VolumeAlertState {
  lastNotified: Date | null;
  lastLevel: AlertLevel;
  snoozedUntil: Date | null;
}

export function initialAlertState(): VolumeAlertState {
  return { lastNotified: null, lastLevel: AlertLevel.ok, snoozedUntil: null };
}

/** Niveau d'après les seuils (Go décimaux). */
export function alertLevel(available: number, total: number, a: AlertsConfig): AlertLevel {
  if (total <= 0) return AlertLevel.ok;
  const pct = (available / total) * 100;
  const gb = available / GB;
  if (pct < a.criticalPercent || gb < a.criticalGB) return AlertLevel.critical;
  if (pct < a.lowPercent || gb < a.lowGB) return AlertLevel.low;
  return AlertLevel.ok;
}

/**
 * Jours avant que le volume soit plein, par régression linéaire sur les 7 derniers jours (au moins 3 relevés, au moins
 * 3 jours d'historique, pente négative ; `null` sinon).
 */
export function daysToFull(readings: readonly VolumeReading[], now: Date): number | null {
  const t = now.getTime();
  const recent = readings.filter((r) => t - r.date.getTime() <= 7 * DAY);
  if (recent.length < 3) return null;
  const first = Math.min(...recent.map((r) => r.date.getTime()));
  if (t - first < 3 * DAY) return null;
  const xs = recent.map((r) => (r.date.getTime() - first) / DAY);
  const ys = recent.map((r) => r.available);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    num += dx * ((ys[i] as number) - my);
    den += dx * dx;
  }
  if (den <= 0) return null;
  const slope = num / den; // octets par jour
  if (slope >= 0) return null;
  const last = recent.reduce((a, b) => (b.date.getTime() > a.date.getTime() ? b : a));
  return last.available / -slope;
}

/**
 * Alerte à envoyer maintenant (`null` sinon) et nouvel état du volume. Règles : une notification par volume et par jour
 * au plus, sauf passage au niveau critique ; un volume revenu 2 points au-dessus du seuil remet le compteur à zéro ;
 * sourdine possible ; alerte anticipée si plein dans moins de 7 jours.
 */
export function evaluateAlert(
  volume: string,
  reading: VolumeReading,
  history: readonly VolumeReading[],
  state: VolumeAlertState,
  a: AlertsConfig,
  now: Date,
): { alert: StorageAlert | null; state: VolumeAlertState } {
  const s: VolumeAlertState = { ...state };
  const pct = reading.total > 0 ? (reading.available / reading.total) * 100 : 100;
  let lvl = alertLevel(reading.available, reading.total, a);
  const days = daysToFull([...history, reading], now);
  if (lvl === AlertLevel.ok && days !== null && days < 7) lvl = AlertLevel.low;

  if (lvl === AlertLevel.ok) {
    // Remise à zéro seulement avec une marge de 2 points (évite les oscillations autour du seuil).
    const freeGB = reading.available / GB;
    if (pct >= a.lowPercent + 2 && freeGB >= a.lowGB) {
      s.lastLevel = AlertLevel.ok;
      s.lastNotified = null;
    }
    return { alert: null, state: s };
  }
  const t = now.getTime();
  if (
    s.snoozedUntil &&
    t < s.snoozedUntil.getTime() &&
    (lvl !== AlertLevel.critical || s.lastLevel === AlertLevel.critical)
  ) {
    return { alert: null, state: s };
  }
  const escalated = lvl > s.lastLevel && lvl === AlertLevel.critical;
  const dayPassed = s.lastNotified ? t - s.lastNotified.getTime() >= DAY : true;
  if (!escalated && !dayPassed) return { alert: null, state: s };
  s.lastNotified = now;
  s.lastLevel = Math.max(lvl, s.lastLevel) as AlertLevel;
  return { alert: { volume, level: lvl, available: reading.available, percentFree: pct, daysToFull: days }, state: s };
}

/** « Ignorer 7 jours ». */
export function snooze(state: VolumeAlertState, now: Date): VolumeAlertState {
  return { ...state, snoozedUntil: new Date(now.getTime() + 7 * DAY) };
}

export function encodeStates(states: Record<string, VolumeAlertState>): string {
  const out: Record<string, JSONValue> = {};
  for (const [volume, s] of Object.entries(states)) {
    out[volume] = {
      lastLevel: s.lastLevel,
      lastNotified: s.lastNotified ? isoDate(s.lastNotified) : undefined,
      snoozedUntil: s.snoozedUntil ? isoDate(s.snoozedUntil) : undefined,
    };
  }
  return compactJSON(out);
}

export function decodeStates(text: string): Record<string, VolumeAlertState> {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) return {};
    const out: Record<string, VolumeAlertState> = {};
    for (const [volume, value] of Object.entries(raw)) {
      const v = value as Record<string, unknown>;
      const level = v?.lastLevel;
      if (level !== 0 && level !== 1 && level !== 2) return {};
      const date = (x: unknown) => (typeof x === "string" ? parseISODate(x) : null);
      out[volume] = { lastLevel: level, lastNotified: date(v.lastNotified), snoozedUntil: date(v.snoozedUntil) };
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadAlertStates(paths: CairnPaths): Promise<Record<string, VolumeAlertState>> {
  try {
    return decodeStates(await readFile(alertsFile(paths), "utf8"));
  } catch {
    return {};
  }
}

export async function saveAlertStates(states: Record<string, VolumeAlertState>, paths: CairnPaths): Promise<void> {
  await paths.prepare(paths.state);
  await writeAtomic(alertsFile(paths), encodeStates(states));
}

/** Met un volume en sourdine pour 7 jours (action « Ignorer 7 jours » de la notification). */
export async function snoozeVolume(volume: string, paths: CairnPaths, now = new Date()): Promise<void> {
  const states = await loadAlertStates(paths);
  states[volume] = snooze(states[volume] ?? initialAlertState(), now);
  await saveAlertStates(states, paths);
}

// MARK: Relevé

export interface StorageCheckOptions {
  paths: CairnPaths;
  /** Dossiers suivis (chemins, `~` accepté) ; les absents sont ignorés. */
  folders: readonly string[];
  alerts: AlertsConfig;
  now?: Date;
  /** Lecture de la capacité (remplacée dans les tests). */
  readVolume?: VolumeReader;
}

export interface StorageCheck {
  /** Alertes à notifier maintenant (anti-harcèlement appliqué ; identifiant de notification `disk-<volume>`). */
  notify: StorageAlert[];
  /** Volumes sous un seuil ou pleins dans moins de 7 jours : à afficher dans le panneau et sur l'accueil. */
  active: StorageAlert[];
}

/**
 * Relève la capacité des volumes des dossiers suivis (sans parcourir les fichiers), enregistre l'historique et l'état
 * anti-harcèlement, et rend les alertes. Appelé toutes les 15 minutes, après une analyse, une suppression, une
 * opération git, et à la fin d'une sauvegarde (`checkStorageAfterBackup`).
 */
export async function checkStorage(options: StorageCheckOptions): Promise<StorageCheck> {
  const { paths, alerts } = options;
  const now = options.now ?? new Date();
  const readVolume = options.readVolume ?? volumeInfo;
  const history = await loadHistory(paths);
  const states = await loadAlertStates(paths);
  const seen = new Set<string>();
  const notify: StorageAlert[] = [];
  const active: StorageAlert[] = [];
  for (const folder of options.folders) {
    const target = expandTilde(folder);
    const available = await stat(target).then(
      () => true,
      () => false,
    );
    if (!available) continue;
    const v = await readVolume(target);
    if (!v || seen.has(v.name)) continue;
    seen.add(v.name);
    const reading: VolumeReading = { date: now, available: v.availableImportant, total: v.total };
    const past = history.readings[v.name] ?? [];
    addReading(history, v.name, reading);
    const { alert, state } = evaluateAlert(v.name, reading, past, states[v.name] ?? initialAlertState(), alerts, now);
    states[v.name] = state;
    const level = alertLevel(reading.available, reading.total, alerts);
    const days = daysToFull([...past, reading], now);
    if (level !== AlertLevel.ok || (days !== null && days < 7)) {
      active.push({
        volume: v.name,
        level: Math.max(AlertLevel.low, level) as AlertLevel,
        available: reading.available,
        percentFree: (reading.available / Math.max(reading.total, 1)) * 100,
        daysToFull: days,
      });
    }
    if (alert) notify.push(alert);
  }
  await saveHistory(history, paths).catch(() => {});
  await saveAlertStates(states, paths).catch(() => {});
  return { notify, active };
}

/**
 * Relevé à la fin d'une sauvegarde (écart corrigé, design.md §12 : la 0.8.0 attendait le relevé suivant, jusqu'à
 * 15 minutes). Même relevé que `checkStorage`, sur les volumes des dossiers suivis.
 */
export function checkStorageAfterBackup(options: StorageCheckOptions): Promise<StorageCheck> {
  return checkStorage(options);
}
