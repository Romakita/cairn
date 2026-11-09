// État des sauvegardes, `~/.cairn/state/runs.json` (port de `RunState`, Retention.swift).
// Format identique à la 0.8.0 (`JSONEncoder`, `.iso8601`, `.prettyPrinted`, `.sortedKeys`) :
// - dates ISO 8601 sans millisecondes (la 0.8.0 refuse les fractions de seconde) ;
// - `damagedVersions`, `lastBytesTransferred` et `lastDuration` toujours écrits : le décodeur Swift les exige, et un
//   champ manquant lui ferait perdre TOUT l'état ;
// - les champs facultatifs absents sont omis.
// La lecture est plus tolérante que la 0.8.0 : un champ illisible est ignoré, pas tout le fichier.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { isoDate, parseISODate } from "../dates.ts";
import { mkdir, readFile, rename, rm, writeFile } from "../fs-promises.ts";
import { type JSONValue, prettyJSON } from "../json.ts";

export const RUN_STATE_FILE = "runs.json";

/** État d'une destination. */
export interface DestinationRunState {
  lastSuccess?: Date;
  lastAttempt?: Date;
  lastError?: string;
  /** Dernier échec réel (pas une destination injoignable) : la planification attend avant de relancer. */
  lastFailure?: Date;
  /** Destination injoignable depuis. */
  waitingSince?: Date;
  lastOverdueNotice?: Date;
  lastVerification?: Date;
  damagedVersions: string[];
  /** Dernier contrôle de l'image disque (`hdiutil verify`) et son résultat. */
  lastImageCheck?: Date;
  lastImageCheckOK?: boolean;
  lastBytesTransferred: number;
  /** Durée de la dernière sauvegarde, en secondes. */
  lastDuration: number;
  /** Fichiers par partie lors de la dernière sauvegarde : total attendu de la barre de progression. */
  fileCounts?: Record<string, number>;
  /** Journaux des versions encore présentes sur la destination (épargnés par la purge des journaux). */
  keptLogs?: string[];
}

export interface RunState {
  destinations: Record<string, DestinationRunState>;
}

/** Emplacement de `state/` (voir `CairnPaths`). */
export interface RunStatePaths {
  state: string;
}

export function emptyDestinationState(): DestinationRunState {
  return { damagedVersions: [], lastBytesTransferred: 0, lastDuration: 0 };
}

export function runStateFile(paths: RunStatePaths): string {
  return path.join(paths.state, RUN_STATE_FILE);
}

/** État d'une destination (vide si elle n'a jamais été sauvegardée), copié : le modifier ne change pas `state`. */
export function destinationState(state: RunState, id: string): DestinationRunState {
  const ds = state.destinations[id];
  return ds ? cloneDestination(ds) : emptyDestinationState();
}

export function cloneDestination(ds: DestinationRunState): DestinationRunState {
  return {
    ...ds,
    damagedVersions: [...ds.damagedVersions],
    fileCounts: ds.fileCounts ? { ...ds.fileCounts } : undefined,
    keptLogs: ds.keptLogs ? [...ds.keptLogs] : undefined,
  };
}

/** Journaux à garder quelle que soit leur ancienneté. */
export function keptLogs(state: RunState): Set<string> {
  return new Set(Object.values(state.destinations).flatMap((d) => d.keptLogs ?? []));
}

// MARK: Décodage

function date(value: unknown): Date | undefined {
  return typeof value === "string" ? (parseISODate(value) ?? undefined) : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function decodeDestination(raw: unknown): DestinationRunState {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ds = emptyDestinationState();
  ds.lastSuccess = date(o.lastSuccess);
  ds.lastAttempt = date(o.lastAttempt);
  ds.lastFailure = date(o.lastFailure);
  ds.waitingSince = date(o.waitingSince);
  ds.lastOverdueNotice = date(o.lastOverdueNotice);
  ds.lastVerification = date(o.lastVerification);
  ds.lastImageCheck = date(o.lastImageCheck);
  if (typeof o.lastError === "string") ds.lastError = o.lastError;
  if (typeof o.lastImageCheckOK === "boolean") ds.lastImageCheckOK = o.lastImageCheckOK;
  ds.damagedVersions = strings(o.damagedVersions) ?? [];
  if (typeof o.lastBytesTransferred === "number") ds.lastBytesTransferred = o.lastBytesTransferred;
  if (typeof o.lastDuration === "number") ds.lastDuration = o.lastDuration;
  if (o.fileCounts && typeof o.fileCounts === "object" && !Array.isArray(o.fileCounts)) {
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.fileCounts)) if (typeof v === "number") counts[k] = v;
    ds.fileCounts = counts;
  }
  ds.keptLogs = strings(o.keptLogs);
  for (const key of Object.keys(ds) as Array<keyof DestinationRunState>) {
    if (ds[key] === undefined) delete ds[key];
  }
  return ds;
}

export function decodeRunState(text: string): RunState {
  try {
    const raw: unknown = JSON.parse(text);
    const dests = raw && typeof raw === "object" ? (raw as Record<string, unknown>).destinations : undefined;
    const out: RunState = { destinations: {} };
    if (dests && typeof dests === "object" && !Array.isArray(dests)) {
      for (const [id, value] of Object.entries(dests)) out.destinations[id] = decodeDestination(value);
    }
    return out;
  } catch {
    return { destinations: {} };
  }
}

// MARK: Encodage

function encodeDestination(ds: DestinationRunState): JSONValue {
  const d = (value: Date | undefined) => (value ? isoDate(value) : undefined);
  return {
    damagedVersions: ds.damagedVersions,
    fileCounts: ds.fileCounts,
    keptLogs: ds.keptLogs,
    lastAttempt: d(ds.lastAttempt),
    lastBytesTransferred: Math.trunc(ds.lastBytesTransferred),
    lastDuration: ds.lastDuration,
    lastError: ds.lastError,
    lastFailure: d(ds.lastFailure),
    lastImageCheck: d(ds.lastImageCheck),
    lastImageCheckOK: ds.lastImageCheckOK,
    lastOverdueNotice: d(ds.lastOverdueNotice),
    lastSuccess: d(ds.lastSuccess),
    lastVerification: d(ds.lastVerification),
    waitingSince: d(ds.waitingSince),
  };
}

/** `runs.json` octet pour octet comme la 0.8.0. */
export function encodeRunState(state: RunState): string {
  const destinations: Record<string, JSONValue> = {};
  for (const [id, ds] of Object.entries(state.destinations)) destinations[id] = encodeDestination(ds);
  return prettyJSON({ destinations });
}

// MARK: Fichier

/** État sur disque ; vide si le fichier est absent ou illisible. */
export async function loadRunState(paths: RunStatePaths): Promise<RunState> {
  try {
    return decodeRunState(await readFile(runStateFile(paths), "utf8"));
  } catch {
    return { destinations: {} };
  }
}

/** Écriture atomique (fichier temporaire puis `rename`), comme `.atomic`. */
export async function saveRunState(paths: RunStatePaths, state: RunState): Promise<void> {
  await mkdir(paths.state, { recursive: true });
  const file = runStateFile(paths);
  const tmp = path.join(paths.state, `.${RUN_STATE_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, encodeRunState(state), "utf8");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Relit l'état juste avant d'écrire (46a9475 : l'app et `cairn` écrivent le même fichier), applique `update` puis
 * enregistre. Seules les destinations touchées par `update` changent.
 */
export async function updateRunState(paths: RunStatePaths, update: (state: RunState) => void): Promise<RunState> {
  const state = await loadRunState(paths);
  update(state);
  await saveRunState(paths, state);
  return state;
}
