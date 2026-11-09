// Orchestration d'une sauvegarde à partir de la configuration (port de `BackupService.run`, `parts`, `finalize`,
// `cancel(destination:)`, et de la logique de notification de `BackupController`). Utilisé par l'app (main) et par
// `cairn backup`.
//
// - Préparation commune (parties, inventaire, IA) affichée sur chaque destination ; une erreur ici est notée sur
//   chaque destination visée (7cc955d) ; un arrêt ici n'est pas un échec (bfbbb61).
// - Copie séquentielle ; la finalisation d'une destination tourne pendant la copie vers la suivante (eb1fc60).
// - « Arrêter » une destination n'arrête qu'elle ; toutes arrêtées → toute la sauvegarde s'arrête.
// - Injoignable : attente (`waitingSince`), pas d'échec (c459b58).
// - Simulation : rien sur la destination, ni `runs.json` ni activité (3692993, e229e52).
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityLog } from "../activity-log.ts";
import { type CairnConfig, type DestinationConfig, folderExpandedPath } from "../config.ts";
import { noPermissionDenied, type PermissionDenied } from "../full-disk-access.ts";
import { t } from "../l10n.ts";
import { OperationLock } from "../lock.ts";
import { machineName } from "../machine.ts";
import type { CairnPaths } from "../paths.ts";
import { expandTilde } from "../paths.ts";
import { CAIRN_VERSION } from "../version.ts";
import { BackupEngine, type BackupOutcome, type CopyResult, type EngineOptions } from "./engine.ts";
import type { ImageCheck } from "./image.ts";
import { recopyPlan, stillDamaged, verifyVersion } from "./integrity.ts";
import {
  type DestinationProgress,
  type DestinationResultSummary,
  DestinationTracker,
  emptyResult,
  type FinishStepId,
  type StepText,
} from "./progress.ts";
import { RunLog } from "./run-log.ts";
import { type DestinationRunState, destinationState, loadRunState, updateRunState } from "./run-state.ts";
import { keychainSecrets } from "./secrets.ts";
import { DestinationSession, type SessionDependencies } from "./session.ts";
import {
  BackupError,
  type BackupPart,
  backupPart,
  describeError,
  isCancelled,
  type PartKind,
  ProviderError,
} from "./types.ts";
import { linkSources, versionLogs, versionsDir } from "./versions.ts";

/** Intervalle de la vérification automatique (échantillon et image) : 30 jours. */
export const VERIFICATION_INTERVAL_MS = 30 * 86_400_000;

export interface BackupRequest {
  /** `undefined` = toutes les destinations. */
  destinationIds?: readonly string[];
  dryRun?: boolean;
  /** `undefined` = toutes les parties. */
  only?: readonly PartKind[];
  /** Limiter la partie IA à ces outils. */
  aiTools?: readonly string[];
}

/** Sauvegarde d'une partie seulement : la version est marquée partielle. */
export function isPartialRequest(r: BackupRequest): boolean {
  return r.only !== undefined || r.aiTools !== undefined;
}

export interface BackupResult {
  destination: string;
  outcome: BackupOutcome | null;
  error: string | null;
  /** Destination injoignable : en attente, ce n'est pas un échec. */
  waiting: boolean;
  /** Arrêtée à la demande. */
  stopped: boolean;
  /** Mot de passe d'une image chiffrée créée par cette sauvegarde, à montrer UNE fois. */
  newImagePassword: string | null;
  /** Fichiers abîmés trouvés par la vérification mensuelle (chemins relatifs à la version). */
  damagedFiles: string[];
  /** Contrôle de l'image disque fait pendant cette sauvegarde (vérification mensuelle). */
  imageCheck: ImageCheck | null;
  /**
   * Éléments que macOS n'a pas laissé lire (sans l'Accès complet au disque : Documents, Téléchargements…) : la
   * sauvegarde réussit avec cet avertissement explicite.
   */
  permissionDenied: PermissionDenied;
  /** Journal de l'exécution. */
  log: string | null;
}

export type BackupNotificationKind = "failed" | "damaged" | "imageFailed" | "permissionDenied";

/** Notification à afficher par le main (jamais d'action destructive, le journal s'ouvre au clic). */
export interface BackupNotification {
  kind: BackupNotificationKind;
  destination: string | null;
  title: string;
  body: string;
  log: string | null;
}

export type BackupEvent =
  | { type: "progress"; progress: DestinationProgress }
  | { type: "notification"; notification: BackupNotification };

/** Classement régénérable (src/core/regenerable.ts), injecté. */
export interface RegenerableRules {
  /** Exclusions d'un dossier suivi (statiques, générés, motifs de l'utilisateur, destinations sous le dossier). */
  forFolder(
    folder: string,
    options: {
      userPatterns: readonly string[];
      destinations: readonly string[];
      isCancelled: () => boolean;
      /** Dossier examiné (relatif), pour la progression. */
      onDir: (dir: string) => void;
    },
  ): Promise<string[]>;
  /** Éléments du home sélectionnés qui existent, hors dossiers IA (`homeItems`). */
  homeItems(include: readonly string[], home: string): Promise<string[]>;
  /** Exclusions appliquées au home (`homeExcludes`). */
  homeExcludes: readonly string[];
}

export interface BackupServiceDependencies extends Partial<Omit<SessionDependencies, "machine">>, EngineOptions {
  regenerable: RegenerableRules;
  /** Dossier personnel (source de la partie `home`). */
  home?: string;
  /** Nom de cette machine (sinon `scutil --get ComputerName`). */
  machine?: string;
  /** Inventaire des outils exporté dans `dir` (`tools.toml` + `Brewfile`). Sans lui, pas de partie `tools`. */
  exportInventory?: (config: CairnConfig, dir: string) => Promise<void>;
  /** Parties IA (snapshots SQLite, profils) ; `warn` reçoit les avertissements (base illisible…). */
  aiParts?: (options: {
    config: CairnConfig;
    staging: string;
    tools: readonly string[] | undefined;
    warn: (text: string) => void;
    isCancelled: () => boolean;
  }) => Promise<BackupPart[]>;
  /** Ligne « open during backup » du journal (outils IA ouverts). */
  openToolsLogLine?: (config: CairnConfig) => Promise<string | null>;
  /** Empêche la veille pendant la sauvegarde ; renvoie la fonction qui la rend. */
  preventSleep?: (reason: string) => () => void;
  /** Relevé du disque après une vraie sauvegarde (alertes de stockage). */
  afterBackup?: (results: readonly BackupResult[]) => Promise<void>;
  /** Nom affiché d'une destination (notifications). */
  destinationLabel?: (d: DestinationConfig) => string;
  now?: () => Date;
  /** Intervalle minimal entre deux envois de progression (ms). */
  progressThrottleMs?: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function swiftArray(items: readonly string[]): string {
  return `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;
}

interface Recorded {
  ds: DestinationRunState;
  result: BackupResult;
}

export class BackupService {
  private listeners = new Set<(e: BackupEvent) => void>();
  private running = false;
  private runPromise: Promise<unknown> | null = null;
  private currentLog: string | null = null;
  private cancelledAll = false;
  private readonly cancelledIds = new Set<string>();
  private pendingIds: Set<string> | null = null;
  private readonly engines = new Map<string, BackupEngine>();
  private readonly trackers = new Map<string, DestinationTracker>();

  constructor(
    readonly paths: CairnPaths,
    readonly config: CairnConfig,
    private readonly deps: BackupServiceDependencies,
  ) {}

  /** Événements (progression, notifications) ; renvoie la fonction de désabonnement. */
  on(listener: (e: BackupEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: BackupEvent): void {
    for (const l of this.listeners) l(e);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Journal de la dernière exécution (aussi quand `run` a échoué après l'avoir créé). */
  get logFile(): string | null {
    return this.currentLog;
  }

  /** Progression de chaque destination visée. */
  progress(): DestinationProgress[] {
    return [...this.trackers.values()].map((t) => t.snapshot());
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private label(id: string): string {
    const d = this.config.destinations.find((x) => x.id === id);
    return d && this.deps.destinationLabel ? this.deps.destinationLabel(d) : id;
  }

  // MARK: Arrêt

  get isCancelled(): boolean {
    return this.cancelledAll;
  }

  private destinationCancelled(id: string): boolean {
    return this.cancelledAll || this.cancelledIds.has(id);
  }

  /** Arrête toute la sauvegarde : préparation, copie et finalisations en cours. */
  cancel(): void {
    this.cancelledAll = true;
    for (const e of this.engines.values()) e.cancel();
  }

  /**
   * Arrête une destination seulement ; les autres continuent. Si plus aucune destination visée ne reste, toute la
   * sauvegarde s'arrête (préparation comprise). Avant `run`, l'arrêt est noté et repris au lancement.
   */
  cancelDestination(id: string): void {
    this.cancelledIds.add(id);
    const pending = this.pendingIds;
    if (!pending) return;
    if ([...pending].every((p) => this.cancelledIds.has(p))) this.cancel();
    else this.engines.get(id)?.cancel();
  }

  /** Veille : les rsync de toutes les destinations sont suspendus, puis repris au réveil. */
  suspend(): void {
    for (const e of this.engines.values()) e.suspend();
  }

  resume(): void {
    for (const e of this.engines.values()) e.resume();
  }

  /** Attend la fin de `run` (rsync arrêté, image détachée, verrou rendu) ; `false` si le délai est dépassé. */
  async waitUntilFinished(timeoutMs: number): Promise<boolean> {
    const p = this.runPromise;
    if (!this.running || !p) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([
        p.then(
          () => true as const,
          () => true as const,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // MARK: Parties

  /**
   * Parties à sauvegarder. `staging` reçoit les fichiers générés (inventaire des outils…). `step` : étape en cours.
   * `isCancelled` : « Arrêter » pendant la préparation lève `cancelled`.
   */
  async parts(
    staging: string,
    request: BackupRequest,
    options: { warn?: (text: string) => void; isCancelled?: () => boolean; step?: (text: StepText) => void } = {},
  ): Promise<BackupPart[]> {
    const cancelled = options.isCancelled ?? (() => false);
    const step = options.step ?? (() => {});
    let lastStep = 0;
    const report = (text: StepText) => {
      const now = Date.now();
      if (now - lastStep < 100) return;
      lastStep = now;
      step(text);
    };
    const want = (k: PartKind) => request.only?.includes(k) ?? true;
    const parts: BackupPart[] = [];
    const destPaths = this.config.destinations
      .filter((d) => d.provider === "local")
      .map((d) => expandTilde(d.path ?? ""));
    if (want("folder")) {
      const used = new Set<string>();
      for (const f of this.config.folders) {
        if (!f.backup) continue;
        const source = folderExpandedPath(f);
        if (!(await exists(source))) continue;
        if (cancelled()) throw BackupError.cancelled();
        let name = path.basename(source);
        while (used.has(name)) name += "-";
        used.add(name);
        const excludes = await this.deps.regenerable.forFolder(source, {
          userPatterns: f.exclude,
          destinations: destPaths,
          isCancelled: cancelled,
          onDir: (dir) => report({ key: "backup.prepare.generated", args: [name + (dir ? `/${dir}` : "")] }),
        });
        if (cancelled()) throw BackupError.cancelled();
        parts.push(backupPart("folder", `folders/${name}`, source, { excludes }));
      }
    }
    if (want("home")) {
      const home = this.deps.home ?? os.homedir();
      const items = await this.deps.regenerable.homeItems(this.config.home.include, home);
      if (items.length > 0) {
        parts.push(
          backupPart("home", "home", home, {
            excludes: [...this.deps.regenerable.homeExcludes, ...this.config.home.exclude],
            filesFrom: items,
          }),
        );
      }
    }
    if (cancelled()) throw BackupError.cancelled();
    if (want("tools") && this.deps.exportInventory) {
      const dir = path.join(staging, "tools");
      step({ key: "backup.prepare.tools", args: [] });
      await mkdir(dir, { recursive: true });
      await this.deps.exportInventory(this.config, dir);
      parts.push(backupPart("tools", "tools", dir));
    }
    if (cancelled()) throw BackupError.cancelled();
    if (want("ai") && this.deps.aiParts) {
      step({ key: "backup.prepare.ai", args: [] });
      parts.push(
        ...(await this.deps.aiParts({
          config: this.config,
          staging,
          tools: request.aiTools,
          warn: options.warn ?? (() => {}),
          isCancelled: cancelled,
        })),
      );
    }
    if (cancelled()) throw BackupError.cancelled();
    return parts;
  }

  // MARK: Exécution

  private sessionDeps(machine: string): SessionDependencies {
    return { ...this.deps, secrets: this.deps.secrets ?? keychainSecrets, machine };
  }

  private engineFor(id: string): BackupEngine {
    const e = new BackupEngine(this.deps);
    this.engines.set(id, e);
    if (this.destinationCancelled(id)) e.cancel();
    return e;
  }

  private tracker(id: string, dryRun: boolean): DestinationTracker {
    const tracker = new DestinationTracker(
      id,
      dryRun,
      (progress) => {
        if (progress.result) this.pendingIds?.delete(id);
        this.emit({ type: "progress", progress });
      },
      { throttleMs: this.deps.progressThrottleMs },
    );
    this.trackers.set(id, tracker);
    return tracker;
  }

  /** Lance la sauvegarde vers chaque destination demandée. Le verrou empêche deux opérations simultanées. */
  run(request: BackupRequest = {}): Promise<BackupResult[]> {
    const p = this.runLocked(request);
    this.runPromise = p;
    return p;
  }

  private async runLocked(request: BackupRequest): Promise<BackupResult[]> {
    const dryRun = request.dryRun ?? false;
    const dests = this.config.destinations.filter((d) => request.destinationIds?.includes(d.id) ?? true);
    const targets = dests.map((d) => d.id);
    this.running = true;
    this.currentLog = null;
    this.pendingIds = new Set(targets);
    this.engines.clear();
    this.trackers.clear();
    // « Arrêter » cliqué avant le lancement sur toutes les destinations visées : rien ne démarre.
    if (targets.length > 0 && targets.every((id) => this.cancelledIds.has(id))) this.cancelledAll = true;
    const lock = new OperationLock({ stateDir: this.paths.state });
    try {
      await lock.acquire(dryRun ? "backup-dry-run" : "backup");
    } catch (error) {
      this.running = false;
      throw error;
    }
    let log: RunLog | null = null;
    let staging: string | null = null;
    let releaseSleep: (() => void) | null = null;
    try {
      log = await RunLog.open(this.paths, dryRun ? "backup-dry-run" : "backup", this.now());
      this.currentLog = log.file;
      staging = path.join(os.tmpdir(), `cairn-staging-${randomUUID().toUpperCase()}`);
      await mkdir(staging, { recursive: true });
      const machine = this.deps.machine ?? (await machineName());
      const trackers = new Map(targets.map((id) => [id, this.tracker(id, dryRun)]));
      // Préparation affichée tout de suite : l'inventaire et l'ouverture de l'image prennent parfois des minutes.
      for (const tr of trackers.values()) tr.preparing({ key: "backup.prepare.parts", args: [] });

      const prepWarnings: string[] = [];
      let parts: BackupPart[];
      try {
        parts = await this.parts(staging, request, {
          warn: (w) => prepWarnings.push(w),
          isCancelled: () => this.cancelledAll,
          step: (text) => {
            for (const tr of trackers.values()) tr.preparing(text);
          },
        });
      } catch (error) {
        if (isCancelled(error)) {
          // « Arrêter » pendant la préparation : rien n'a été écrit, ce n'est pas un échec.
          log.write("cancelled before destinations");
          for (const tr of trackers.values()) tr.finish(emptyResult("stopped", { log: log.file }));
          throw error;
        }
        const message = describeError(error);
        log.write(`error before destinations: ${message}`);
        // Noté sur chaque destination visée : l'état l'affiche et la planification attend avant de relancer.
        if (!dryRun) {
          const now = this.now();
          await updateRunState(this.paths, (s) => {
            for (const id of targets) {
              const ds = destinationState(s, id);
              ds.lastAttempt = now;
              ds.lastFailure = now;
              ds.lastError = message;
              s.destinations[id] = ds;
            }
          });
          const stoppedAll = targets.every((id) => this.destinationCancelled(id));
          if (!stoppedAll) {
            this.emit({
              type: "notification",
              notification: {
                kind: "failed",
                destination: null,
                title: t("backup.notify.failed_title"),
                body: message,
                log: log.file,
              },
            });
          }
        }
        for (const tr of trackers.values()) tr.finish(emptyResult("failed", { error: message, log: log.file }));
        throw error;
      }
      if (this.cancelledAll) {
        log.write("cancelled before destinations");
        for (const tr of trackers.values()) tr.finish(emptyResult("stopped", { log: log.file }));
        throw BackupError.cancelled();
      }
      log.write(`parts: ${parts.map((p) => p.target).join(", ")}`);
      if (request.only?.includes("ai") ?? true) {
        const line = await this.deps.openToolsLogLine?.(this.config);
        if (line) log.write(line);
      }
      // Destinations suivantes : en attente pendant la copie vers la première.
      for (const id of targets.slice(1)) trackers.get(id)?.queued();
      releaseSleep = this.deps.preventSleep?.("Cairn backup") ?? null;

      const state = await loadRunState(this.paths);
      const recorded = new Map<string, Recorded>();
      const finishing: Promise<void>[] = [];
      for (const d of dests) {
        const tracker = trackers.get(d.id)!;
        // Arrêt demandé : les destinations suivantes ne sont pas commencées.
        if (this.cancelledAll) {
          tracker.finish(emptyResult("stopped", { log: log.file }));
          continue;
        }
        if (this.destinationCancelled(d.id)) {
          log.write(`${d.id}: cancelled before start`);
          tracker.finish(emptyResult("stopped", { log: log.file }));
          continue;
        }
        const engine = this.engineFor(d.id);
        const session = new DestinationSession(d, this.sessionDeps(machine));
        const ds = destinationState(state, d.id);
        ds.lastAttempt = this.now();
        if (!(await session.provider.isReachable())) {
          ds.waitingSince ??= this.now();
          log.write(`${d.id}: unreachable, waiting`);
          const error = ProviderError.unreachable(d.id).message;
          recorded.set(d.id, { ds, result: this.result(d.id, { error, waiting: true, log: log.file }) });
          tracker.finish(emptyResult("waiting", { error, log: log.file }));
          continue;
        }
        tracker.preparing({ key: "backup.prepare.open", args: [] });
        let copied: CopyResult;
        let dir: string;
        let recopy: Record<string, string[]>;
        try {
          // Une simulation n'écrit rien : ni image, ni dossier. Sur une destination encore vide, elle simule contre
          // un dossier temporaire vide (tout serait copié).
          let root: string;
          try {
            root = await session.open(!dryRun);
          } catch (error) {
            if (!(dryRun && error instanceof ProviderError && error.reason === "notCreated")) throw error;
            root = path.join(staging, "empty-destination");
          }
          // Montage du partage et de l'image (non interruptibles) : l'arrêt demandé entre-temps est pris ici.
          if (engine.isCancelled) throw BackupError.cancelled();
          dir = versionsDir(root, machine);
          recopy = await recopyPlan(await linkSources(parts, dir), parts);
          copied = await engine.copy(
            {
              parts,
              root,
              retention: d.retention,
              dryRun,
              machine,
              now: this.now(),
              manifestExtra: {
                cairn: CAIRN_VERSION,
                destination: d.id,
                config_version: this.config.version,
                log: log.name,
              },
              forceRecopy: recopy,
              partial: isPartialRequest(request),
              warnings: prepWarnings,
              expectedFiles: ds.fileCounts ?? {},
            },
            tracker,
          );
        } catch (error) {
          await session.close().catch(() => {});
          const message = describeError(error);
          ds.lastError = message;
          if (!dryRun) ds.lastFailure = this.now();
          log.write(`${d.id}: error ${message}`);
          const stopped = isCancelled(error) && this.destinationCancelled(d.id);
          recorded.set(d.id, {
            ds,
            result: this.result(d.id, {
              error: message,
              stopped,
              newImagePassword: session.newImagePassword,
              log: log.file,
            }),
          });
          tracker.finish(emptyResult(stopped ? "stopped" : "failed", { error: message, log: log.file }));
          continue;
        }
        // Finalisation en arrière-plan : la copie vers la destination suivante commence tout de suite.
        finishing.push(
          this.finalize(d, { engine, session, copied, ds, dir, recopy, dryRun, log, tracker }).then((r) => {
            recorded.set(d.id, r);
          }),
        );
      }
      await Promise.all(finishing);

      const results = dests.flatMap((d) => {
        const r = recorded.get(d.id);
        return r ? [r.result] : [];
      });
      if (!dryRun) {
        await updateRunState(this.paths, (s) => {
          for (const [id, r] of recorded) {
            const fresh = s.destinations[id];
            // Notice de retard écrite entre-temps par l'app : gardée (46a9475).
            if (
              fresh?.lastOverdueNotice &&
              (!r.ds.lastOverdueNotice || fresh.lastOverdueNotice > r.ds.lastOverdueNotice)
            ) {
              r.ds.lastOverdueNotice = fresh.lastOverdueNotice;
            }
            s.destinations[id] = r.ds;
          }
        });
        // Activité récente de l'accueil : réussite ou échec par destination (sans le message d'erreur).
        const activity = new ActivityLog({ stateDir: this.paths.state });
        for (const r of results) {
          if (r.waiting) continue;
          await activity
            .append({
              date: this.now(),
              kind: r.error === null ? "backupSucceeded" : "backupFailed",
              subject: r.destination,
              bytes: r.outcome?.bytesTransferred,
            })
            .catch(() => {});
        }
      }
      for (const n of this.notifications(results, dryRun)) this.emit({ type: "notification", notification: n });
      if (!dryRun && this.deps.afterBackup) await this.deps.afterBackup(results).catch(() => {});
      return results;
    } finally {
      releaseSleep?.();
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
      await log?.close();
      await lock.release();
      this.running = false;
    }
  }

  private result(destination: string, r: Partial<BackupResult>): BackupResult {
    return {
      destination,
      outcome: null,
      error: null,
      waiting: false,
      stopped: false,
      newImagePassword: null,
      damagedFiles: [],
      imageCheck: null,
      permissionDenied: noPermissionDenied(),
      log: null,
      ...r,
    };
  }

  /** Notifications de fin (échec sauf simulation et arrêt demandé, fichiers abîmés, image en échec). */
  notifications(results: readonly BackupResult[], dryRun: boolean): BackupNotification[] {
    const out: BackupNotification[] = [];
    for (const r of results) {
      const label = this.label(r.destination);
      if (r.error !== null && !r.waiting && !dryRun && !r.stopped && !this.destinationCancelled(r.destination)) {
        out.push({
          kind: "failed",
          destination: r.destination,
          title: t("backup.notify.failed_title"),
          body: r.error,
          log: r.log,
        });
      }
      if (r.damagedFiles.length > 0) {
        out.push({
          kind: "damaged",
          destination: r.destination,
          title: t("backup.notify.damaged_title", label),
          body: t("backup.notify.damaged_body", r.damagedFiles.length),
          log: r.log,
        });
      }
      if (r.permissionDenied.count > 0 && !dryRun) {
        out.push({
          kind: "permissionDenied",
          destination: r.destination,
          title: t("backup.notify.permission_title", label),
          body: t("backup.notify.permission_body", r.permissionDenied.count),
          log: r.log,
        });
      }
      if (r.imageCheck && !r.imageCheck.ok) {
        out.push({
          kind: "imageFailed",
          destination: r.destination,
          title: t("backup.notify.image_failed_title", label),
          body: r.imageCheck.output,
          log: r.log,
        });
      }
    }
    return out;
  }

  /**
   * Finalisation d'une destination copiée : empreintes, version, vérification mensuelle, fermeture (et compactage
   * après une réussite seulement, 0547a02). Tourne en arrière-plan.
   */
  private async finalize(
    d: DestinationConfig,
    c: {
      engine: BackupEngine;
      session: DestinationSession;
      copied: CopyResult;
      ds: DestinationRunState;
      dir: string;
      recopy: Record<string, string[]>;
      dryRun: boolean;
      log: RunLog;
      tracker: DestinationTracker;
    },
  ): Promise<Recorded> {
    const { engine, session, copied, ds, dir, dryRun, log, tracker } = c;
    const verifyDue =
      !dryRun &&
      (!ds.lastVerification || this.now().getTime() - ds.lastVerification.getTime() > VERIFICATION_INTERVAL_MS);
    const closing: FinishStepId = session.usesImage ? "compact" : "close";
    if (!dryRun) {
      tracker.beginFinishing([
        "listing",
        "checksums",
        "version",
        ...(verifyDue ? (["sample"] as const) : []),
        ...(verifyDue && session.usesImage ? (["image"] as const) : []),
        closing,
      ]);
    }
    let succeeded = false;
    let recorded: Recorded;
    try {
      const outcome = await engine.finish(copied, tracker);
      succeeded = true;
      for (const w of outcome.warnings) log.write(`${d.id}: ${w}`);
      const denied = outcome.permissionDenied;
      if (denied.count > 0) {
        log.write(
          `${d.id}: permission denied by macOS for ${denied.count} item(s), not backed up (Full Disk Access): ${swiftArray(denied.examples)}`,
        );
      }
      let damagedFiles: string[] = [];
      let imageCheck: ImageCheck | null = null;
      if (!dryRun) {
        ds.lastSuccess = this.now();
        delete ds.waitingSince;
        delete ds.lastError;
        ds.lastBytesTransferred = outcome.bytesTransferred;
        ds.lastDuration = outcome.duration;
        ds.fileCounts = { ...(ds.fileCounts ?? {}), ...outcome.filesByPart };
        log.write(
          `${d.id}: version ${outcome.version ?? "-"} ${outcome.bytesTransferred} bytes, deleted ${swiftArray(outcome.deletedVersions)}`,
        );
        // Journaux des versions encore gardées : la purge des journaux les épargne.
        ds.keptLogs = await versionLogs(dir);
        // Les versions dont les fichiers abîmés viennent d'être recopiés (ou supprimées) ne comptent plus.
        ds.damagedVersions = await stillDamaged(ds.damagedVersions, dir, c.recopy);
        // Vérification mensuelle : échantillon de la nouvelle version, puis l'image disque (détachée).
        if (verifyDue && outcome.version) {
          tracker.step("sample");
          const report = await verifyVersion(path.join(dir, outcome.version), {
            full: false,
            progress: (done, total) => tracker.step("sample", { done, total }),
          });
          ds.lastVerification = this.now();
          damagedFiles = report.damaged;
          if (report.damaged.length > 0 && !ds.damagedVersions.includes(outcome.version)) {
            ds.damagedVersions.push(outcome.version);
          }
          log.write(`${d.id}: verification ${report.checked} files, ${report.damaged.length} damaged`);
          for (const p of report.damaged.slice(0, 50)) log.write(`${d.id}: damaged ${outcome.version}/${p}`);
          if (session.usesImage) tracker.step("image");
          const check = await session.verifyImage();
          if (check) {
            imageCheck = check;
            ds.lastImageCheck = this.now();
            ds.lastImageCheckOK = check.ok;
            log.write(`${d.id}: image verify ${check.ok ? "ok" : "FAILED"}: ${check.output}`);
          }
        }
      }
      recorded = {
        ds,
        result: this.result(d.id, {
          outcome,
          newImagePassword: session.newImagePassword,
          damagedFiles,
          imageCheck,
          permissionDenied: outcome.permissionDenied,
          log: log.file,
        }),
      };
    } catch (error) {
      const message = describeError(error);
      ds.lastError = message;
      if (!dryRun) ds.lastFailure = this.now();
      log.write(`${d.id}: error ${message}`);
      const stopped = isCancelled(error) && this.destinationCancelled(d.id);
      recorded = {
        ds,
        result: this.result(d.id, {
          error: message,
          stopped,
          newImagePassword: session.newImagePassword,
          log: log.file,
        }),
      };
    }
    if (!dryRun) {
      if (!succeeded && closing === "compact") tracker.replaceStep("compact", "close");
      tracker.step(succeeded ? closing : "close");
    }
    try {
      await session.close(succeeded && !dryRun);
    } catch (error) {
      log.write(`${d.id}: close ${describeError(error)}`);
    }
    tracker.finish(this.summary(recorded.result));
    return recorded;
  }

  private summary(r: BackupResult): DestinationResultSummary {
    const status = r.waiting ? "waiting" : r.stopped ? "stopped" : r.error !== null ? "failed" : "succeeded";
    return emptyResult(status, {
      version: r.outcome?.version ?? null,
      error: r.error,
      warnings: r.outcome?.warnings ?? [],
      filesTransferred: r.outcome?.filesTransferred ?? 0,
      bytesTransferred: r.outcome?.bytesTransferred ?? 0,
      deletedVersions: r.outcome?.deletedVersions ?? [],
      damagedFiles: r.damagedFiles,
      imageCheck: r.imageCheck,
      permissionDenied: r.permissionDenied,
      log: r.log,
    });
  }
}
