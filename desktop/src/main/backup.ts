// Sauvegarde dans l'app (port de BackupController.swift, partie exécution) : lancement, arrêt par destination, veille
// (SIGSTOP/SIGCONT par le service), anti-veille, notifications de fin, état par destination (joignabilité, historique,
// actions indisponibles), vérification. La planification est dans scheduler.ts.
import path from "node:path";
import { powerSaveBlocker } from "electron";
import { defaultBackupDependencies } from "../core/backup/defaults.ts";
import type { DestinationProgress } from "../core/backup/progress.ts";
import { type BackupResult, BackupService } from "../core/backup/run.ts";
import {
  type DestinationRunState,
  emptyDestinationState,
  loadRunState,
  type RunState,
} from "../core/backup/run-state.ts";
import { keychainSecrets } from "../core/backup/secrets.ts";
import { DestinationSession, providerFor } from "../core/backup/session.ts";
import { describeError, isCancelled } from "../core/backup/types.ts";
import { verifyDestination } from "../core/backup/verify.ts";
import { dateOfVersion, isPartial, listVersions, versionsDir } from "../core/backup/versions.ts";
import type { DestinationConfig } from "../core/config.ts";
import { BACKUP_ACTIONS, type BackupAction, unavailableReason } from "../core/destinations/actions.ts";
import { destinationHealth, nextBackup } from "../core/health.ts";
import { t } from "../core/l10n.ts";
import { OperationLock } from "../core/lock.ts";
import type {
  BackupResultView,
  BackupView,
  DestinationView,
  HistoryView,
  StartBackupArgs,
  VerificationView,
  VerifyArgs,
} from "../shared/contract.ts";
import { ApiError, errorMessage } from "./errors.ts";
import type { Host } from "./host.ts";

const EMPTY_HISTORY: HistoryView = { status: "idle", versions: [], error: null, loadedAt: null };
/** Quitter l'app annule la sauvegarde et attend au plus 5 s (la version reste incomplète et sera reprise). */
export const QUIT_WAIT_MS = 5000;

function resultView(r: BackupResult): BackupResultView {
  const { newImagePassword: _secret, outcome, ...rest } = r;
  return {
    ...rest,
    version: outcome?.version ?? null,
    filesTransferred: outcome?.filesTransferred ?? 0,
    bytesTransferred: outcome?.bytesTransferred ?? 0,
    bytesByPart: outcome?.bytesByPart ?? {},
  };
}

export class BackupController {
  private service: BackupService | null = null;
  private dryRun = false;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private readonly progress = new Map<string, DestinationProgress>();
  private readonly stopping = new Set<string>();
  private log: string | null = null;
  private lastResults: BackupResultView[] | null = null;
  private lastError: string | null = null;
  private newImagePasswords: { destination: string; password: string }[] = [];
  private runState: RunState = { destinations: {} };
  /** Joignabilité sondée (`null` : pas encore). */
  private readonly reachable = new Map<string, boolean>();
  /** Injoignable au dernier tour du planificateur. */
  waiting: Record<string, boolean> = {};
  private readonly history = new Map<string, HistoryView>();
  private verification: VerificationView | null = null;
  /** Les rsync sont suspendus (veille). */
  private suspended = false;
  private runPromise: Promise<void> | null = null;
  /** Appelé à la fin de chaque sauvegarde (rechargement de l'historique, mises à jour…). */
  onFinished: (() => void) | null = null;

  constructor(private readonly host: Host) {}

  get running(): boolean {
    return this.service?.isRunning ?? false;
  }

  get verifying(): boolean {
    return this.verification?.running ?? false;
  }

  /** État des destinations (`runs.json`), relu. */
  async reloadRunState(): Promise<void> {
    try {
      this.runState = await loadRunState(this.host.paths);
    } catch {
      // fichier illisible : on garde le dernier état
    }
    this.host.changed();
  }

  state(id: string): DestinationRunState {
    return this.runState.destinations[id] ?? emptyDestinationState();
  }

  get states(): RunState {
    return this.runState;
  }

  setReachable(id: string, value: boolean): void {
    if (this.reachable.get(id) === value) return;
    this.reachable.set(id, value);
    this.host.changed();
  }

  /** Sonde la joignabilité de chaque destination (sans rien monter). */
  async probeReachability(destinations: readonly DestinationConfig[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    const machine = await this.host.machine();
    await Promise.all(
      destinations.map(async (d) => {
        const ok = await providerFor(d, { secrets: keychainSecrets, machine })
          .isReachable()
          .catch(() => false);
        out[d.id] = ok;
        this.setReachable(d.id, ok);
      }),
    );
    return out;
  }

  // MARK: Exécution

  /**
   * Lance une sauvegarde (ou une simulation). Refusée si la configuration est invalide, si une destination est
   * inconnue ou si une autre opération tient le verrou. La promesse se résout au lancement ; la fin arrive par l'état.
   */
  async start(args: StartBackupArgs, options: { scheduled?: boolean } = {}): Promise<void> {
    if (this.running) throw new ApiError("busy", t("update.blocked.backup"));
    if (this.host.configInvalid()) throw new ApiError("invalidConfig", t("config.save.refused", ""));
    const config = this.host.config();
    const known = new Set(config.destinations.map((d) => d.id));
    if (known.size === 0) throw new ApiError("notFound", "no destination");
    for (const id of args.destinations ?? []) {
      if (!known.has(id)) throw new ApiError("notFound", `unknown destination ${id}`);
    }
    if (await OperationLock.isHeld({ stateDir: this.host.paths.state })) {
      throw new ApiError("locked", "another operation is already running");
    }
    const service = new BackupService(
      this.host.paths,
      config,
      defaultBackupDependencies({
        preventSleep: (reason) => {
          const id = powerSaveBlocker.start("prevent-app-suspension");
          void reason;
          return () => {
            if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
          };
        },
        afterBackup: () => this.host.checkStorage(),
        destinationLabel: (d) => this.host.destinationLabel(d),
        progressThrottleMs: 100,
      }),
    );
    this.service = service;
    this.dryRun = args.dryRun ?? false;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.progress.clear();
    this.stopping.clear();
    this.lastError = null;
    this.lastResults = null;
    this.log = null;
    this.suspended = false;
    service.on((e) => {
      if (e.type === "progress") {
        this.progress.set(e.progress.destination, e.progress);
        this.log = service.logFile;
        this.host.changed();
      } else {
        const n = e.notification;
        this.host.notifier.postWithLog(n.title, n.body, n.log);
      }
    });
    void options;
    const run = service.run({
      destinationIds: args.destinations,
      dryRun: args.dryRun,
      only: args.only,
      aiTools: args.aiTools,
    });
    this.host.changed(true);
    this.runPromise = run.then(
      (results) => this.finished(results, null),
      (error) => this.finished(null, error),
    );
  }

  private async finished(results: BackupResult[] | null, error: unknown): Promise<void> {
    const service = this.service;
    this.finishedAt = Date.now();
    this.log = service?.logFile ?? this.log;
    if (results) {
      this.lastResults = results.map(resultView);
      for (const r of results) {
        if (r.newImagePassword)
          this.newImagePasswords.push({ destination: r.destination, password: r.newImagePassword });
        if (r.waiting) this.setReachable(r.destination, false);
        else if (r.error === null) this.setReachable(r.destination, true);
      }
    } else if (error && !isCancelled(error)) {
      this.lastError = describeError(error);
      this.host.message("error", this.lastError);
    }
    this.stopping.clear();
    await this.reloadRunState();
    this.host.changed(true);
    this.onFinished?.();
  }

  /** Arrête une destination, ou toute la sauvegarde. */
  stop(destination?: string): void {
    const service = this.service;
    if (!service?.isRunning) return;
    if (destination) {
      this.stopping.add(destination);
      service.cancelDestination(destination);
    } else {
      for (const p of this.progress.keys()) this.stopping.add(p);
      service.cancel();
    }
    this.host.changed();
  }

  /** Veille : les rsync sont suspendus (SIGSTOP), puis repris au réveil (SIGCONT). */
  suspend(): void {
    if (!this.running || this.suspended) return;
    this.suspended = true;
    this.service?.suspend();
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.service?.resume();
  }

  /** Fermeture de l'app : arrêt de la sauvegarde, attente de 5 s au plus (verrou rendu, image détachée). */
  async shutdown(timeoutMs = QUIT_WAIT_MS): Promise<void> {
    const service = this.service;
    if (!service?.isRunning) return;
    this.resume();
    service.cancel();
    await service.waitUntilFinished(timeoutMs);
  }

  /** Attend la fin de l'exécution en cours (tests). */
  async idle(): Promise<void> {
    await this.runPromise;
  }

  acknowledgePassword(destination: string): void {
    this.newImagePasswords = this.newImagePasswords.filter((p) => p.destination !== destination);
    this.host.changed();
  }

  // MARK: Historique et vérification

  /** Lit les versions de ce Mac sur la destination (montée puis démontée), sans rien créer. */
  async refreshHistory(id: string): Promise<void> {
    const d = this.host.config().destinations.find((x) => x.id === id);
    if (!d) throw new ApiError("notFound", `unknown destination ${id}`);
    if (this.history.get(id)?.status === "loading") return;
    const previous = this.history.get(id) ?? EMPTY_HISTORY;
    this.history.set(id, { ...previous, status: "loading" });
    this.host.changed();
    const machine = await this.host.machine();
    const session = new DestinationSession(d, { secrets: keychainSecrets, machine });
    try {
      const root = await session.open(false);
      const dir = versionsDir(root, machine);
      const damaged = new Set(this.state(id).damagedVersions);
      const names = await listVersions(dir);
      const versions = [];
      for (const name of names.reverse()) {
        versions.push({
          name,
          date: dateOfVersion(name)?.getTime() ?? null,
          partial: await isPartial(path.join(dir, name)),
          damaged: damaged.has(name),
        });
      }
      this.history.set(id, { status: "loaded", versions, error: null, loadedAt: Date.now() });
      this.setReachable(id, true);
    } catch (error) {
      // Un échec ne bloque pas le rechargement automatique suivant, sans boucle de nouvelles tentatives.
      this.history.set(id, { ...previous, status: "failed", error: describeError(error), loadedAt: Date.now() });
    } finally {
      await session.close().catch(() => {});
      this.host.changed();
    }
  }

  async verify(args: VerifyArgs): Promise<void> {
    if (this.verifying) throw new ApiError("busy", t("backup.unavailable.verifying"));
    if (this.running) throw new ApiError("busy", t("backup.unavailable.running"));
    const d = this.host.config().destinations.find((x) => x.id === args.destination);
    if (!d) throw new ApiError("notFound", `unknown destination ${args.destination}`);
    const machine = await this.host.machine();
    const view: VerificationView = {
      destination: d.id,
      full: args.full ?? false,
      running: true,
      version: null,
      done: 0,
      total: 0,
      reports: [],
      error: null,
    };
    this.verification = view;
    this.host.changed();
    void verifyDestination(
      d,
      this.host.paths,
      { secrets: keychainSecrets, machine },
      {
        version: args.version,
        full: args.full ?? false,
        imagePassword: args.imagePassword ?? null,
        sharePassword: args.sharePassword ?? null,
        progress: (version, done, total) => {
          view.version = version;
          view.done = done;
          view.total = total;
          this.host.changed();
        },
      },
    )
      .then((reports) => {
        view.reports = reports.map((r) => ({
          version: r.version,
          damaged: r.damaged.length,
          missingChecksums: r.missingChecksums,
        }));
      })
      .catch((error) => {
        view.error = errorMessage(error);
      })
      .finally(async () => {
        view.running = false;
        await this.reloadRunState();
      });
  }

  // MARK: Vues

  view(): BackupView {
    return {
      running: this.running,
      dryRun: this.dryRun,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      destinations: [...this.progress.values()],
      stopping: [...this.stopping],
      log: this.log,
      lastResults: this.lastResults,
      lastError: this.lastError,
      newImagePasswords: this.newImagePasswords,
    };
  }

  verificationView(): VerificationView | null {
    return this.verification ? { ...this.verification, reports: [...this.verification.reports] } : null;
  }

  destinationViews(now: Date = new Date()): DestinationView[] {
    const config = this.host.config();
    return config.destinations.map((d) => {
      const run = this.state(d.id);
      const reachable = this.reachable.has(d.id) ? (this.reachable.get(d.id) ?? null) : null;
      const waiting = this.waiting[d.id] ?? false;
      const history = this.history.get(d.id) ?? EMPTY_HISTORY;
      const hasBackups = history.status === "loaded" ? history.versions.length > 0 : run.lastSuccess !== undefined;
      const backingUp = this.running && this.progress.has(d.id);
      const unavailable = Object.fromEntries(
        BACKUP_ACTIONS.map((a) => [
          a,
          unavailableReason(a, { reachable, backingUp, verifying: this.verifying, hasBackups }),
        ]),
      ) as Record<BackupAction, string | null>;
      return {
        id: d.id,
        label: this.host.destinationLabel(d),
        provider: d.provider,
        config: d,
        health: destinationHealth(run, waiting, config.schedule, now),
        reachable,
        waiting,
        run,
        nextBackup: nextBackup(config.schedule, run.lastSuccess ?? null, now)?.getTime() ?? null,
        history,
        unavailable,
      };
    });
  }

  versionCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, h] of this.history) if (h.status === "loaded") out[id] = h.versions.length;
    return out;
  }
}
