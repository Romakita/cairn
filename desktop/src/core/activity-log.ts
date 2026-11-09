// Journal d'activité affiché sur l'accueil (port de `ActivityLog`, ActivityLog.swift) : `state/activity.jsonl`, une
// ligne JSON par événement, 200 au plus. Seuls des noms (destination, volume) et des compteurs y sont écrits, jamais
// de chemin ni de message d'erreur. Lignes identiques à la 0.8.0 : JSON compact, clés triées, date ISO 8601 à la
// seconde, champs absents omis.
//
// L'app et la commande `cairn` écrivent en même temps : la lecture-modification-écriture se fait sous un `flock`
// bloquant sur `state/activity.lock` (🐞 85501aa), en plus d'une file d'attente dans le processus (un seul fil de
// libuv attend le verrou à la fois : plusieurs attentes occuperaient tout le pool, et l'écriture du détenteur ne
// pourrait plus se faire).
import { randomBytes } from "node:crypto";
import { close, constants, open } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isoDate, parseISODate } from "./dates.ts";
import { compactJSON } from "./json.ts";
import { native } from "./native.ts";

export interface StatePaths {
  stateDir: string;
}

export const ACTIVITY_KINDS = [
  "backupSucceeded",
  "backupFailed",
  "cleanup",
  "gitCleanup",
  "diskAlert",
  "check",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityEvent {
  date: Date;
  kind: ActivityKind;
  /** Destination ou volume concerné. */
  subject?: string;
  /** Compteur : éléments supprimés, branches, problèmes trouvés… */
  count?: number;
  bytes?: number;
  /** Niveau : `critical` pour une alerte de disque critique. */
  level?: string;
}

export const ACTIVITY_MAX_LINES = 200;

/** Ligne du journal, octet pour octet comme `JSONEncoder` (`.iso8601`, `.sortedKeys`). */
export function encodeActivityEvent(event: ActivityEvent): string {
  return compactJSON({
    bytes: event.bytes ?? undefined,
    count: event.count ?? undefined,
    date: isoDate(event.date),
    kind: event.kind,
    level: event.level ?? undefined,
    subject: event.subject ?? undefined,
  });
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Événement d'une ligne, `null` si elle est illisible (ligne ignorée, comme le décodeur Swift). */
export function decodeActivityEvent(line: string): ActivityEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.date !== "string" || typeof o.kind !== "string") return null;
  const date = parseISODate(o.date);
  if (!date || !(ACTIVITY_KINDS as readonly string[]).includes(o.kind)) return null;
  const event: ActivityEvent = { date, kind: o.kind as ActivityKind };
  for (const key of ["subject", "level"] as const) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return null;
    event[key] = v;
  }
  for (const key of ["count", "bytes"] as const) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    if (!isInteger(v)) return null;
    event[key] = v;
  }
  return event;
}

const openFd = promisify(open);
const closeFd = promisify(close);

/** File d'attente par fichier, dans ce processus. */
const queues = new Map<string, Promise<void>>();

function serialized(key: string, work: () => Promise<void>): Promise<void> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

export class ActivityLog {
  readonly file: string;
  readonly lockFile: string;

  constructor(paths: StatePaths) {
    this.file = path.join(paths.stateDir, "activity.jsonl");
    this.lockFile = path.join(paths.stateDir, "activity.lock");
  }

  /** Ajoute un événement ; au-delà de 200 lignes, les plus anciennes sont retirées. */
  append(event: ActivityEvent): Promise<void> {
    return serialized(this.file, async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const fd = await openFd(this.lockFile, constants.O_RDWR | constants.O_CREAT, 0o600);
      try {
        await native().flockExclusive(fd);
        try {
          const lines = await this.readLines();
          lines.push(encodeActivityEvent(event));
          if (lines.length > ACTIVITY_MAX_LINES) lines.splice(0, lines.length - ACTIVITY_MAX_LINES);
          await writeAtomically(this.file, `${lines.join("\n")}\n`);
        } finally {
          native().flockUnlock(fd);
        }
      } finally {
        await closeFd(fd);
      }
    });
  }

  /** Les `limit` derniers événements, du plus récent au plus ancien (vide si le fichier est absent). */
  async recent(limit = 10): Promise<ActivityEvent[]> {
    const events: ActivityEvent[] = [];
    for (const line of await this.readLines()) {
      const event = decodeActivityEvent(line);
      if (event) events.push(event);
    }
    // Ordre d'écriture = ordre chronologique.
    return events.reverse().slice(0, Math.max(0, limit));
  }

  private async readLines(): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    return text.split("\n").filter((line) => line.length > 0);
  }
}

/** Écriture atomique (fichier temporaire puis `rename`), comme `write(atomically: true)`. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export interface BackupDaysOptions {
  days?: number;
  now?: Date;
  /** Fuseau des jours : `local` (défaut, comme `Calendar.current`) ou `utc` (tests). */
  timeZone?: "local" | "utc";
}

/**
 * Sauvegardes des `days` derniers jours, du plus ancien à aujourd'hui : `true` si une sauvegarde a réussi ce
 * jour-là, `false` si elles ont toutes échoué, `null` sans sauvegarde.
 */
export function backupDays(events: readonly ActivityEvent[], options: BackupDaysOptions = {}): (boolean | null)[] {
  const days = options.days ?? 7;
  const now = options.now ?? new Date();
  const utc = options.timeZone === "utc";
  const key = (d: Date) =>
    utc
      ? `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
      : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const dayAt = (offset: number) =>
    utc
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  const out: (boolean | null)[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = key(dayAt(offset));
    const kinds = events.filter((e) => key(e.date) === day).map((e) => e.kind);
    out.push(kinds.includes("backupSucceeded") ? true : kinds.includes("backupFailed") ? false : null);
  }
  return out;
}
