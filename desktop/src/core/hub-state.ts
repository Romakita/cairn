// État de la page d'accueil (port de `HubState` et `HubRecord`, HubState.swift) : état global, problèmes classés par
// priorité et carte de chaque module. Décisions pures, à partir de données déjà disponibles (aucune analyse lancée) ;
// les libellés sont produits par l'interface.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AnalysisSummary, reclaimableBytes } from "./analysis.ts";
import { defaultConfig, type ScheduleConfig } from "./config.ts";
import { isoDate, parseISODate } from "./dates.ts";
import { selectedBranchByDefault, selectedWorktreeByDefault } from "./git/selection.ts";
import type { GitOptions, RepoReport } from "./git/types.ts";
import { type DestinationStatus, destinationHealth, type HealthLevel, nextBackup, worstLevel } from "./health.ts";
import { compactJSON } from "./json.ts";
import { type Calendar, localCalendar } from "./schedule/calendar.ts";
import { AlertLevel, type StorageAlert } from "./storage-alerts.ts";

/** Genres de problème, du plus urgent au moins urgent. */
export const ISSUE_KINDS = [
  "configInvalid",
  "backupFailed",
  "diskCritical",
  "destinationOverdue",
  "diskLow",
  "folderUnavailable",
  "versionsDamaged",
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export interface HubIssue {
  kind: IssueKind;
  /** Objet du problème : volume, destination (libellé), dossier ; vide pour la configuration. */
  subject: string;
  /** Identifiant pour la navigation : id de la destination, nom du volume, chemin du dossier. */
  ref?: string;
  /** Précision : ligne fautive de la configuration… */
  detail?: string;
  /** Espace libre du volume, nombre de versions abîmées. */
  bytes?: number;
}

/** Erreur pour la configuration invalide et la sauvegarde en échec (comme l'icône de la barre des menus). */
export function issueLevel(issue: HubIssue): HealthLevel {
  return issue.kind === "configInvalid" || issue.kind === "backupFailed" ? "error" : "attention";
}

export type HubModule = "storage" | "backup" | "git" | "ai" | "restore";
export const HUB_MODULES: readonly HubModule[] = ["storage", "backup", "git", "ai", "restore"];

/** Ton d'une carte : `unknown` tant que le module n'a pas de données, `info` quand une action est possible. */
export type HubTone = "ok" | "info" | "attention" | "error" | "unknown";

/** Chiffre ou phrase clé d'une carte. */
export type HubFigure =
  | { kind: "notAnalyzed" }
  | { kind: "free"; bytes: number }
  | { kind: "noDestination" }
  | { kind: "backingUp" }
  | { kind: "failed"; label: string }
  | { kind: "unreachable"; label: string }
  | { kind: "lastBackup"; date: Date }
  | { kind: "neverBackedUp" }
  | { kind: "gitCandidates"; count: number }
  | { kind: "gitClean" }
  | { kind: "aiTools"; count: number }
  | { kind: "noAITool" }
  | { kind: "versions"; count: number }
  | { kind: "lastVersion"; date: Date }
  | { kind: "noVersion" };

/** Ligne secondaire d'une carte. */
export type HubDetail =
  | { kind: "none" }
  | { kind: "reclaimable"; bytes: number }
  | { kind: "nextBackup"; date: Date }
  | { kind: "backupDue" }
  | { kind: "manualSchedule" }
  | { kind: "gitReclaimable"; bytes: number }
  | { kind: "aiLastBackup"; date: Date }
  | { kind: "destinations"; count: number }
  | { kind: "damaged"; count: number }
  | { kind: "latestVersion" };

/** Action principale : navigation, ou sauvegarde pour « Sauvegarder maintenant ». Jamais destructive. */
export type HubAction =
  | "clean"
  | "analyze"
  | "backupNow"
  | "addDestination"
  | "openBackup"
  | "analyzeGit"
  | "openGit"
  | "viewAI"
  | "restore";

export interface ModuleState {
  module: HubModule;
  tone: HubTone;
  figure: HubFigure;
  detail: HubDetail;
  action: HubAction;
}

export interface HubDestination {
  id: string;
  label: string;
  state: DestinationStatus;
  /** Injoignable au dernier contrôle. */
  waiting: boolean;
}

/** Alerte d'espace disque en cours (`StorageAlert` de `storage-alerts.ts`). */
export type VolumeAlert = Pick<StorageAlert, "volume" | "level" | "available">;

/** Candidats au nettoyage git sélectionnés par défaut, et octets récupérables. */
export interface GitSummary {
  candidates: number;
  bytes: number;
}

/**
 * Résumé des rapports git pour la carte : branches et worktrees sélectionnés par défaut, octets des dépôts plus ceux
 * de ces worktrees.
 */
export function summarizeGit(reports: readonly RepoReport[], options: GitOptions): GitSummary {
  const branches = reports.flatMap((r) => r.branches).filter((b) => selectedBranchByDefault(b, options)).length;
  const worktrees = reports.flatMap((r) => r.worktrees).filter((w) => selectedWorktreeByDefault(w, options));
  const bytes = reports.reduce((n, r) => n + r.reclaimableBytes, 0) + worktrees.reduce((n, w) => n + w.size, 0);
  return { candidates: branches + worktrees.length, bytes };
}

/** Données d'entrée (valeurs simples fournies par l'app ou par les tests). */
export interface HubInputs {
  /** Erreurs bloquantes de `config.toml` (description avec la ligne). */
  configErrors: string[];
  destinations: HubDestination[];
  schedule: ScheduleConfig;
  /** Alertes de volume en cours (tous les volumes suivis). */
  volumeAlerts: VolumeAlert[];
  unavailableFolders: string[];
  /** Espace libre du volume principal (`null` si inconnu). */
  freeBytes: number | null;
  /** Dernière analyse, `null` sans analyse. */
  summary: AnalysisSummary | null;
  /** `null` : git jamais analysé (voir `summarizeGit`). */
  git: GitSummary | null;
  /** Outils IA détectés (`null` : pas encore relevé). */
  aiDetected: number | null;
  aiLastBackup: Date | null;
  /** Nombre de versions par destination, quand la liste a été lue. */
  versions: Record<string, number>;
  isBackingUp: boolean;
  now: Date;
  calendar: Calendar;
}

export function hubInputs(values: Partial<HubInputs> = {}): HubInputs {
  return {
    configErrors: [],
    destinations: [],
    schedule: defaultConfig().schedule,
    volumeAlerts: [],
    unavailableFolders: [],
    freeBytes: null,
    summary: null,
    git: null,
    aiDetected: null,
    aiLastBackup: null,
    versions: {},
    isBackingUp: false,
    now: new Date(),
    calendar: localCalendar,
    ...values,
  };
}

export interface HubState {
  overall: HealthLevel;
  /** Problèmes triés par priorité. */
  causes: HubIssue[];
  modules: ModuleState[];
  topIssue: HubIssue | null;
}

export function hubModule(state: HubState, m: HubModule): ModuleState {
  return state.modules.find((x) => x.module === m)!;
}

function health(i: HubInputs, d: HubDestination): HealthLevel {
  return destinationHealth(d.state, d.waiting, i.schedule, i.now, i.calendar);
}

/** Problèmes en cours, du plus urgent au moins urgent (mêmes règles que l'icône de la barre des menus). */
export function hubIssues(i: HubInputs): HubIssue[] {
  const out: HubIssue[] = i.configErrors.map((e) => ({ kind: "configInvalid", subject: "", detail: e }));
  for (const d of i.destinations) {
    const level = health(i, d);
    if (level === "error") {
      out.push({ kind: "backupFailed", subject: d.label, ref: d.id });
    } else if (level === "attention") {
      const damaged = d.state.damagedVersions?.length ?? 0;
      if (damaged > 0) out.push({ kind: "versionsDamaged", subject: d.label, ref: d.id, bytes: damaged });
      else out.push({ kind: "destinationOverdue", subject: d.label, ref: d.id });
    }
  }
  for (const a of i.volumeAlerts) {
    if (a.level === AlertLevel.ok) continue;
    out.push({
      kind: a.level === AlertLevel.critical ? "diskCritical" : "diskLow",
      subject: a.volume,
      ref: a.volume,
      bytes: a.available,
    });
  }
  for (const f of i.unavailableFolders) out.push({ kind: "folderUnavailable", subject: path.basename(f), ref: f });
  // Tri stable : à priorité égale, l'ordre d'entrée est gardé.
  return out
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => ISSUE_KINDS.indexOf(a.issue.kind) - ISSUE_KINDS.indexOf(b.issue.kind) || a.index - b.index)
    .map((x) => x.issue);
}

/** État global seul (icône de la barre des menus) : le niveau le plus grave des problèmes. */
export function hubOverall(i: HubInputs): HealthLevel {
  return worstLevel(hubIssues(i).map(issueLevel));
}

export function makeHubState(i: HubInputs): HubState {
  const causes = hubIssues(i);
  return {
    overall: worstLevel(causes.map(issueLevel)),
    causes,
    modules: [storageModule(i), backupModule(i), gitModule(i), aiModule(i), restoreModule(i)],
    topIssue: causes[0] ?? null,
  };
}

function storageModule(i: HubInputs): ModuleState {
  const level = Math.max(AlertLevel.ok, ...i.volumeAlerts.map((a) => a.level));
  const tone: HubTone =
    level === AlertLevel.critical
      ? "error"
      : level === AlertLevel.low
        ? "attention"
        : i.summary === null
          ? "unknown"
          : "ok";
  const figure: HubFigure = i.freeBytes !== null ? { kind: "free", bytes: i.freeBytes } : { kind: "notAnalyzed" };
  if (i.summary === null) return { module: "storage", tone, figure, detail: { kind: "none" }, action: "analyze" };
  const bytes = reclaimableBytes(i.summary);
  return {
    module: "storage",
    tone,
    figure,
    detail: { kind: "reclaimable", bytes },
    action: bytes > 0 ? "clean" : "analyze",
  };
}

function maxDate(dates: (Date | null | undefined)[]): Date | null {
  let max: Date | null = null;
  for (const d of dates) if (d && (!max || d > max)) max = d;
  return max;
}

function backupModule(i: HubInputs): ModuleState {
  if (i.destinations.length === 0) {
    return {
      module: "backup",
      tone: "attention",
      figure: { kind: "noDestination" },
      detail: { kind: "none" },
      action: "addDestination",
    };
  }
  const worst = worstLevel(i.destinations.map((d) => health(i, d)));
  const last = maxDate(i.destinations.map((d) => d.state.lastSuccess));
  let tone: HubTone = worst === "error" ? "error" : worst === "attention" ? "attention" : last ? "ok" : "unknown";
  let figure: HubFigure;
  const failed = i.destinations.find((d) => d.state.lastError !== undefined && d.state.lastError !== null);
  const waiting = i.destinations.find((d) => d.waiting);
  if (i.isBackingUp) {
    figure = { kind: "backingUp" };
  } else if (failed) {
    figure = { kind: "failed", label: failed.label };
  } else if (waiting) {
    figure = { kind: "unreachable", label: waiting.label };
    if (tone === "ok" || tone === "unknown") tone = "info";
  } else if (last) {
    figure = { kind: "lastBackup", date: last };
  } else {
    figure = { kind: "neverBackedUp" };
  }
  let detail: HubDetail;
  const nexts = i.destinations
    .map((d) => nextBackup(i.schedule, d.state.lastSuccess, i.now, i.calendar))
    .filter((d): d is Date => d !== null);
  if (i.schedule.frequency === "manual") {
    detail = { kind: "manualSchedule" };
  } else if (nexts.length > 0) {
    const next = new Date(Math.min(...nexts.map((d) => d.getTime())));
    detail = next <= i.now ? { kind: "backupDue" } : { kind: "nextBackup", date: next };
  } else {
    detail = { kind: "destinations", count: i.destinations.length };
  }
  return { module: "backup", tone, figure, detail, action: worst === "error" ? "openBackup" : "backupNow" };
}

function gitModule(i: HubInputs): ModuleState {
  if (i.git === null) {
    return {
      module: "git",
      tone: "unknown",
      figure: { kind: "notAnalyzed" },
      detail: { kind: "none" },
      action: "analyzeGit",
    };
  }
  if (i.git.candidates === 0) {
    return { module: "git", tone: "ok", figure: { kind: "gitClean" }, detail: { kind: "none" }, action: "openGit" };
  }
  return {
    module: "git",
    tone: "info",
    figure: { kind: "gitCandidates", count: i.git.candidates },
    detail: i.git.bytes > 0 ? { kind: "gitReclaimable", bytes: i.git.bytes } : { kind: "none" },
    action: "openGit",
  };
}

function aiModule(i: HubInputs): ModuleState {
  if (i.aiDetected === null) {
    return {
      module: "ai",
      tone: "unknown",
      figure: { kind: "notAnalyzed" },
      detail: { kind: "none" },
      action: "viewAI",
    };
  }
  const n = i.aiDetected;
  return {
    module: "ai",
    tone: n > 0 ? "ok" : "unknown",
    figure: n > 0 ? { kind: "aiTools", count: n } : { kind: "noAITool" },
    detail: i.aiLastBackup ? { kind: "aiLastBackup", date: i.aiLastBackup } : { kind: "none" },
    action: "viewAI",
  };
}

function restoreModule(i: HubInputs): ModuleState {
  const damaged = i.destinations.reduce((n, d) => n + (d.state.damagedVersions?.length ?? 0), 0);
  const last = maxDate(i.destinations.map((d) => d.state.lastSuccess));
  const known = i.destinations.flatMap((d) => (i.versions[d.id] !== undefined ? [i.versions[d.id]!] : []));
  const total = known.reduce((a, b) => a + b, 0);
  const figure: HubFigure =
    known.length > 0
      ? { kind: "versions", count: total }
      : last
        ? { kind: "lastVersion", date: last }
        : { kind: "noVersion" };
  const tone: HubTone = damaged > 0 ? "attention" : last === null && total === 0 ? "unknown" : "ok";
  const detail: HubDetail =
    damaged > 0
      ? { kind: "damaged", count: damaged }
      : known.length === 0 && last !== null
        ? { kind: "latestVersion" }
        : { kind: "none" };
  return { module: "restore", tone, figure, detail, action: "restore" };
}

// MARK: Dernière vérification complète (`state/hub.json`)

export interface HubRecord {
  lastCheck: Date | null;
}

export function hubRecordFile(stateDir: string): string {
  return path.join(stateDir, "hub.json");
}

/** `state/hub.json`, ou un état vide s'il est absent ou illisible. */
export async function loadHubRecord(stateDir: string): Promise<HubRecord> {
  try {
    const raw = JSON.parse(await readFile(hubRecordFile(stateDir), "utf8")) as { lastCheck?: unknown };
    const lastCheck = typeof raw.lastCheck === "string" ? parseISODate(raw.lastCheck) : null;
    return { lastCheck };
  } catch {
    return { lastCheck: null };
  }
}

/** Écriture atomique, au format de la 0.8.0 (`{"lastCheck":"…Z"}`, date sans millisecondes). */
export async function saveHubRecord(stateDir: string, record: HubRecord): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const file = hubRecordFile(stateDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = compactJSON(record.lastCheck ? { lastCheck: isoDate(record.lastCheck) } : {});
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
