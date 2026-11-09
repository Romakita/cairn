// L'app (process principal) : possède l'état, l'assemble en `AppSnapshot` pour les fenêtres, et branche les services
// (configuration, sauvegarde et planificateur, analyse et alertes, git, outils, destinations, mises à jour), la barre
// des menus, les notifications, l'ouverture à la connexion et l'arrêt propre (design.md, décision 6).
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, shell } from "electron";
import { type ActivityEvent, ActivityLog, backupDays } from "../core/activity-log.ts";
import { keptLogs } from "../core/backup/run-state.ts";
import { type CairnConfig, type DestinationConfig, folderExpandedPath } from "../core/config.ts";
import { pruneLogs } from "../core/config-logs.ts";
import { setSmbPassword } from "../core/config-secrets.ts";
import { ConfigStore } from "../core/config-store.ts";
import { FULL_DISK_ACCESS_SETTINGS_URL, type FullDiskAccess, fullDiskAccess } from "../core/full-disk-access.ts";
import { hubInputs, loadHubRecord, makeHubState, saveHubRecord, summarizeGit } from "../core/hub-state.ts";
import { configureLanguage, currentLanguage, t } from "../core/l10n.ts";
import { OperationLock } from "../core/lock.ts";
import { machineName } from "../core/machine.ts";
import { detectDraft, homeChoices } from "../core/onboarding.ts";
import { pathSuggestions } from "../core/path-completion.ts";
import { CairnPaths } from "../core/paths.ts";
import { CAIRN_VERSION } from "../core/version.ts";
import {
  type ActivityView,
  type AppSnapshot,
  type BackgroundView,
  CONTRACT_VERSION,
  type LockView,
  type MessageView,
  type NavigationRequest,
  type OpenTarget,
  type RestoreView,
  type ShowTarget,
} from "../shared/contract.ts";
import { AnalysisService, StorageService } from "./analysis.ts";
import { BackupController } from "./backup.ts";
import { ConfigService, draftToWire } from "./config-service.ts";
import { type Confirmer, confirmWithDialog } from "./confirm.ts";
import { ConfirmationTokens } from "./confirmation-tokens.ts";
import { DestinationsService } from "./destinations.ts";
import { ApiError, errorMessage } from "./errors.ts";
import { GitService } from "./git.ts";
import type { Host } from "./host.ts";
import { allowedExternalURL, createMainWindow, distDir, preloadPath } from "./interface.ts";
import { type Handlers, registerHandlers } from "./ipc.ts";
import { type NotificationAction, Notifier } from "./notifications.ts";
import { SnapshotPublisher } from "./publisher.ts";
import { RestoreController } from "./restore.ts";
import { Scheduler } from "./scheduler.ts";
import { ToolsService } from "./tools.ts";
import { MenuBar, trayState } from "./tray.ts";
import { UpdateController } from "./updates.ts";

const LOCK_POLL_MS = 10_000;
const LOG_PURGE_MS = 24 * 3600 * 1000;
const MAX_MESSAGES = 5;
/** Accès complet au disque refusé : sondé de nouveau toutes les 60 s (l'utilisateur peut l'accorder à tout moment). */
const ACCESS_POLL_MS = 60_000;

/** Exécution de test de bout en bout (dossier de données à part, jamais dans l'app empaquetée). */
function e2eMode(): boolean {
  return !app.isPackaged && process.env.CAIRN_E2E_USER_DATA !== undefined;
}

/**
 * Sonde de l'Accès complet au disque. En test de bout en bout, l'état vient de `CAIRN_E2E_FULL_DISK_ACCESS` (accordé
 * par défaut) : le résultat ne dépend pas des autorisations de la machine qui lance les tests.
 */
function probeFullDiskAccess(): Promise<FullDiskAccess> {
  if (e2eMode()) {
    const forced = process.env.CAIRN_E2E_FULL_DISK_ACCESS;
    return Promise.resolve(forced === "denied" || forced === "unknown" ? forced : "granted");
  }
  return fullDiskAccess(os.homedir());
}

export class CairnApp implements Host {
  readonly paths = new CairnPaths();
  readonly store = new ConfigStore(this.paths);
  readonly gitWorkerFile = path.join(distDir(), "git-worker.cjs");
  readonly activity = new ActivityLog({ stateDir: this.paths.state });
  readonly confirm: Confirmer = confirmWithDialog;
  /** Jetons émis quand une feuille de l'interface a confirmé une action destructive (une seule confirmation). */
  readonly confirmations = new ConfirmationTokens();
  readonly notifier = new Notifier((action) => this.notificationAction(action));

  private readonly publisher = new SnapshotPublisher(() => this.snapshot());
  readonly configs = new ConfigService(this.store, () => this.configChanged());
  readonly backup = new BackupController(this);
  readonly scheduler = new Scheduler(this, this.backup, !e2eMode());
  readonly analysis = new AnalysisService(this);
  readonly storage = new StorageService(this, () => this.analysis.lastSummary);
  readonly git = new GitService(this);
  readonly tools = new ToolsService(this);
  readonly destinations = new DestinationsService(this);
  readonly restore = new RestoreController(this);
  readonly updates = new UpdateController(this, () => app.quit());
  private menuBar: MenuBar | null = null;
  private mainWindow: BrowserWindow | null = null;

  private revision = 0;
  private machinePromise: Promise<string> | null = null;
  private messages: MessageView[] = [];
  private nextMessage = 1;
  private lock: LockView = { held: false, byOther: false, holder: null };
  private recentActivity: ActivityEvent[] = [];
  private unavailableFolders: string[] = [];
  private lastHubCheck: Date | null = null;
  private checkingAll = false;
  private fullDisk: FullDiskAccess = "unknown";
  private timers: NodeJS.Timeout[] = [];
  private quitting = false;
  private unregister: (() => void) | null = null;

  constructor(private readonly options: { nativeError: string | null }) {
    this.backup.onFinished = () => {
      void this.reloadActivity();
      void this.pollLock();
      for (const d of this.config().destinations) {
        if (this.backup.state(d.id).lastSuccess) void this.backup.refreshHistory(d.id).catch(() => {});
      }
    };
  }

  // MARK: Host

  changed(urgent = false): void {
    this.publisher.changed(urgent);
    this.updateTray();
  }

  config(): CairnConfig {
    return this.configs.config;
  }

  async saveConfig(config: CairnConfig): Promise<void> {
    await this.configs.saveConfig(config);
  }

  configInvalid(): boolean {
    return this.configs.invalid;
  }

  message(level: MessageView["level"], text: string): void {
    this.messages = [...this.messages, { id: this.nextMessage++, level, text, date: Date.now() }].slice(-MAX_MESSAGES);
    this.changed();
  }

  machine(): Promise<string> {
    this.machinePromise ??= machineName();
    return this.machinePromise;
  }

  isBackingUp(): boolean {
    return this.backup.running;
  }

  destinationLabel(d: DestinationConfig): string {
    if (d.provider === "smb") {
      try {
        return d.url ? new URL(d.url).host || d.id : d.id;
      } catch {
        return d.id;
      }
    }
    return d.path ? path.basename(d.path) || d.id : d.id;
  }

  checkStorage(): Promise<void> {
    return this.storage.check().then(() => this.refreshFolders());
  }

  logActivity(event: Omit<ActivityEvent, "date">): void {
    void this.activity
      .append({ ...event, date: new Date() })
      .then(() => this.reloadActivity())
      .catch(() => {});
  }

  navigate(request: NavigationRequest): void {
    const window = this.showMainWindow();
    const send = () => this.publisher.navigate(request, window.webContents);
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
    else send();
  }

  // MARK: Démarrage et arrêt

  async start(): Promise<void> {
    await this.paths.ensure().catch(() => {});
    this.unregister = registerHandlers(this.handlers(), this.confirmations);
    await this.configs.load();
    await this.configs.watch();
    if (this.options.nativeError) this.message("error", this.options.nativeError);
    await Promise.all([
      this.analysis.loadSummary(),
      this.backup.reloadRunState(),
      this.reloadActivity(),
      this.refreshFolders(),
      loadHubRecord(this.paths.state).then((r) => {
        this.lastHubCheck = r.lastCheck;
      }),
    ]);
    this.menuBar = new MenuBar(preloadPath(), { openMain: () => this.showMainWindow(), quit: () => app.quit() });
    this.updateTray();
    // Ouverte à la connexion en tâche de fond : seulement la barre des menus.
    const atLogin = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
    if (!atLogin || !this.config().schedule.background) this.showMainWindow();
    else app.setActivationPolicy("accessory");

    this.storage.start();
    this.scheduler.start();
    void this.updates.start();
    void this.purgeLogs();
    void this.pollLock();
    void this.probeAccess();
    this.timers.push(setInterval(() => void this.pollLock(), LOCK_POLL_MS));
    this.timers.push(
      setInterval(() => {
        if (this.fullDisk === "denied") void this.probeAccess();
      }, ACCESS_POLL_MS),
    );
    // Retour au premier plan (souvent depuis Réglages Système) : l'accès vient peut-être d'être accordé.
    app.on("browser-window-focus", () => void this.probeAccess());
    this.timers.push(setInterval(() => void this.purgeLogs(), LOG_PURGE_MS));

    app.on("second-instance", () => this.showMainWindow());
    app.on("activate", () => this.showMainWindow());
    app.on("window-all-closed", () => this.allWindowsClosed());
    app.on("before-quit", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.quitting = true;
      void this.shutdown().finally(() => app.quit());
    });
    if (e2eMode()) (globalThis as Record<string, unknown>).__cairnTest = this.testHooks();
    this.changed();
  }

  /** Arrêt propre : la sauvegarde est annulée (attente de 5 s au plus), analyses arrêtées, sonde démontée. */
  async shutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.scheduler.stop();
    this.storage.stop();
    this.updates.stop();
    this.configs.stop();
    this.analysis.cancel();
    this.git.cancel();
    await Promise.allSettled([this.backup.shutdown(), this.destinations.closeProbe(), this.restore.close()]);
    this.publisher.stop();
    this.unregister?.();
    this.menuBar?.destroy();
    this.menuBar = null;
  }

  private allWindowsClosed(): void {
    // Tâche de fond : l'app reste dans la barre des menus, sans Dock. Sinon, elle se ferme.
    if (this.config().schedule.background) app.setActivationPolicy("accessory");
    else app.quit();
  }

  showMainWindow(hash = ""): BrowserWindow {
    let window = this.mainWindow;
    if (!window || window.isDestroyed()) {
      app.setActivationPolicy("regular");
      window = createMainWindow(hash);
      this.mainWindow = window;
      this.publisher.add(window.webContents);
      window.on("closed", () => {
        if (this.mainWindow === window) this.mainWindow = null;
      });
    } else {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    return window;
  }

  private configChanged(): void {
    const config = this.config();
    configureLanguage(config.language, app.getPreferredSystemLanguages());
    this.applyBackground(config.schedule.background);
    void this.refreshFolders();
    this.changed();
  }

  /** Ouverture à la connexion (seulement dans l'app empaquetée : jamais pour le binaire Electron de développement). */
  private applyBackground(enabled: boolean): void {
    if (!app.isPackaged) return;
    try {
      if (app.getLoginItemSettings().openAtLogin !== enabled) app.setLoginItemSettings({ openAtLogin: enabled });
    } catch {
      // refusé par le système : l'état l'indique
    }
  }

  private backgroundView(): BackgroundView {
    const enabled = this.config().schedule.background;
    if (!app.isPackaged) return { enabled, status: "unknown" };
    const s = app.getLoginItemSettings() as Electron.LoginItemSettings & { status?: string };
    const known = ["enabled", "not-registered", "requires-approval", "not-found"] as const;
    const status = known.find((k) => k === s.status) ?? "unknown";
    return { enabled, status };
  }

  private async refreshFolders(): Promise<void> {
    const missing: string[] = [];
    for (const f of this.config().folders) {
      const ok = await stat(folderExpandedPath(f)).then(
        () => true,
        () => false,
      );
      if (!ok) missing.push(f.path);
    }
    if (missing.join("\n") !== this.unavailableFolders.join("\n")) {
      this.unavailableFolders = missing;
      this.changed();
    }
  }

  private async reloadActivity(): Promise<void> {
    this.recentActivity = await this.activity.recent(200).catch(() => []);
    this.changed();
  }

  private async purgeLogs(): Promise<void> {
    await pruneLogs(this.paths, this.config().logRetentionDays, keptLogs(this.backup.states)).catch(() => []);
  }

  /** Verrou d'opération sondé toutes les 10 s (la commande `cairn` peut le tenir). */
  private async pollLock(): Promise<void> {
    const state = { stateDir: this.paths.state };
    const held = await OperationLock.isHeld(state).catch(() => false);
    const ours = this.backup.running || this.backup.verifying || this.git.view().applying;
    const holder = held ? await new OperationLock(state).holderDescription() : null;
    const next: LockView = { held, byOther: held && !ours, holder };
    if (JSON.stringify(next) !== JSON.stringify(this.lock)) {
      this.lock = next;
      this.changed();
    }
  }

  /** Accès complet au disque, publié s'il change. */
  private async probeAccess(): Promise<void> {
    const next = await probeFullDiskAccess().catch((): FullDiskAccess => "unknown");
    if (next === this.fullDisk) return;
    this.fullDisk = next;
    this.changed();
  }

  private updateTray(): void {
    if (!this.menuBar) return;
    const overall = this.hubState().overall;
    this.menuBar.update(trayState(overall, this.backup.running));
  }

  // MARK: Notifications

  private notificationAction(action: NotificationAction): void {
    switch (action.kind) {
      case "openLog":
        void this.openLog(action.log);
        break;
      case "clean":
        this.navigate({ route: "clean", ref: action.volume, preselect: this.analysis.cleanupPreselection });
        break;
      case "snooze":
        void this.storage.snooze(action.volume);
        break;
    }
  }

  private async openLog(file: string): Promise<void> {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(`${path.resolve(this.paths.logs)}${path.sep}`) || !resolved.endsWith(".log")) {
      throw new ApiError("forbidden", "not a Cairn log");
    }
    await stat(resolved).catch(() => {
      throw new ApiError("notFound", resolved);
    });
    const error = await shell.openPath(resolved);
    if (error) throw new ApiError("failed", error);
  }

  // MARK: Instantané

  private hubState() {
    const config = this.config();
    const view = this.configs.view();
    return makeHubState(
      hubInputs({
        configErrors: view.issues.filter((i) => i.severity === "error").map((i) => i.description),
        destinations: config.destinations.map((d) => ({
          id: d.id,
          label: this.destinationLabel(d),
          state: this.backup.state(d.id),
          waiting: this.backup.waiting[d.id] ?? false,
        })),
        schedule: config.schedule,
        volumeAlerts: this.storage.active,
        unavailableFolders: this.unavailableFolders,
        freeBytes: this.storage.view().freeBytes,
        summary: this.analysis.lastSummary,
        git: this.git.analyzed ? summarizeGit(this.git.lastReports, this.git.currentOptions) : null,
        aiDetected: this.tools.detectedCount,
        aiLastBackup: this.tools.aiLastBackup,
        versions: this.backup.versionCounts(),
        isBackingUp: this.backup.running,
        fullDiskAccess: this.fullDisk,
        now: new Date(),
      }),
    );
  }

  private restoreView(): RestoreView {
    return this.restore.view();
  }

  snapshot(): AppSnapshot {
    this.revision += 1;
    const now = new Date();
    const activity: ActivityView[] = this.recentActivity.slice(0, 50).map((e) => ({
      kind: e.kind,
      date: e.date.getTime(),
      ...(e.subject !== undefined ? { subject: e.subject } : {}),
      ...(e.count !== undefined ? { count: e.count } : {}),
      ...(e.bytes !== undefined ? { bytes: e.bytes } : {}),
      ...(e.level !== undefined ? { level: e.level } : {}),
    }));
    return {
      revision: this.revision,
      contract: CONTRACT_VERSION,
      version: CAIRN_VERSION,
      language: currentLanguage(),
      packaged: app.isPackaged,
      firstLaunch: this.configs.firstLaunch,
      config: this.configs.view(),
      destinations: this.backup.destinationViews(now),
      backup: this.backup.view(),
      verification: this.backup.verificationView(),
      analysis: this.analysis.view(now),
      storage: this.storage.view(),
      git: this.git.view(),
      inventory: this.tools.inventoryView(),
      ai: this.tools.aiView(),
      hub: {
        ...this.hubState(),
        lastCheck: this.lastHubCheck?.getTime() ?? null,
        checking: this.checkingAll,
      },
      backupDays: backupDays(this.recentActivity, { now }),
      activity,
      updates: this.updates.view(),
      lock: this.lock,
      restore: this.restoreView(),
      background: this.backgroundView(),
      access: { fullDisk: this.fullDisk },
      notificationsSupported: this.notifier.supported,
      messages: this.messages,
    };
  }

  // MARK: « Tout vérifier »

  private async checkAll(): Promise<void> {
    if (this.checkingAll) throw new ApiError("busy", t("hub.checking"));
    this.checkingAll = true;
    this.changed();
    try {
      const config = this.config();
      await this.backup.probeReachability(config.destinations);
      if (config.folders.length > 0) {
        await this.analysis.scan().catch(() => {});
        if (this.checkingAll) await this.git.analyze({ fullCheck: true }).catch(() => {});
      }
      if (!this.checkingAll) return;
      this.lastHubCheck = new Date();
      await saveHubRecord(this.paths.state, { lastCheck: this.lastHubCheck }).catch(() => {});
      this.logActivity({ kind: "check", count: this.hubState().causes.length });
    } finally {
      this.checkingAll = false;
      this.changed();
    }
  }

  private cancelCheckAll(): void {
    this.checkingAll = false;
    this.analysis.cancel();
    this.git.cancel();
  }

  // MARK: Système

  /** Chemin connu du main : sous un dossier suivi, sous `~/.cairn`, une destination locale ou un dépôt analysé. */
  private knownPath(p: string): boolean {
    const resolved = path.resolve(p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
    const roots = [
      this.paths.root,
      ...this.config().folders.map(folderExpandedPath),
      ...this.config()
        .destinations.flatMap((d) => (d.provider === "local" && d.path ? [d.path] : []))
        .map((p2) => path.resolve(p2.startsWith("~/") ? path.join(os.homedir(), p2.slice(2)) : p2)),
      ...this.git.lastReports.map((r) => r.path),
    ];
    return roots.some((r) => resolved === r || resolved.startsWith(`${r}${path.sep}`));
  }

  private async openTarget(target: OpenTarget): Promise<void> {
    let file: string;
    switch (target.kind) {
      case "log":
        return this.openLog(target.file);
      case "config":
        file = this.store.file;
        break;
      case "logs":
        file = this.paths.logs;
        break;
      case "node": {
        const n = this.analysis.node(target.nodeId);
        // Un fichier n'est jamais « ouvert » (il pourrait être exécutable) : il est montré dans le Finder.
        if (!n.isDirectory) {
          shell.showItemInFolder(n.path);
          return;
        }
        file = n.path;
        break;
      }
      case "repo":
        if (!this.git.lastReports.some((r) => r.path === target.repo)) throw new ApiError("notFound", target.repo);
        file = target.repo;
        break;
    }
    const error = await shell.openPath(file);
    if (error) throw new ApiError("failed", error);
  }

  private showInFinder(target: ShowTarget): void {
    if (target.kind === "node") {
      shell.showItemInFolder(this.analysis.node(target.nodeId).path);
      return;
    }
    if (!this.knownPath(target.path)) throw new ApiError("forbidden", "unknown path");
    shell.showItemInFolder(target.path);
  }

  private async chooseFolder(buttonLabel?: string, defaultPath?: string): Promise<string | null> {
    const parent = BrowserWindow.getFocusedWindow() ?? this.mainWindow ?? undefined;
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      ...(buttonLabel ? { buttonLabel } : {}),
      ...(defaultPath ? { defaultPath } : {}),
    };
    const r = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  }

  // MARK: Méthodes de l'API

  private handlers(): Handlers {
    return {
      getSnapshot: (_args, event) => {
        this.publisher.add(event.sender);
        return this.snapshot();
      },

      startBackup: (args) => this.backup.start(args),
      stopBackup: (args) => this.backup.stop(args.destination),
      acknowledgeImagePassword: (args) => this.backup.acknowledgePassword(args.destination),
      verify: (args) => this.backup.verify(args),
      refreshHistory: (args) => this.backup.refreshHistory(args.destination),

      scan: (args) => {
        // Refus immédiat (aucun dossier, analyse en cours) : l'erreur revient à l'appelant ; sinon la fin arrive par l'état.
        const run = this.analysis.scan(args.folders);
        if (!this.analysis.running) return run;
        void run.catch((e) => this.message("error", errorMessage(e)));
      },
      cancelScan: () => this.analysis.cancel(),
      analysisChildren: (args) => this.analysis.children(args.nodeId),
      removeNodes: (args, _event, ctx) => this.analysis.remove(args.nodeIds, args.permanently ?? false, ctx.confirmed),
      checkStorage: () => this.checkStorage(),
      snoozeAlert: (args) => this.storage.snooze(args.volume),
      checkAll: () => {
        void this.checkAll().catch((e) => this.message("error", errorMessage(e)));
      },
      cancelCheckAll: () => this.cancelCheckAll(),

      gitAnalyze: (args) => {
        const run = this.git.analyze(args);
        if (!this.git.running) return run;
        void run.catch((e) => this.message("error", errorMessage(e)));
      },
      gitCancel: () => this.git.cancel(),
      gitApply: (args, _event, ctx) => this.git.apply(args.selections, ctx.confirmed),
      gitCompact: (args, _event, ctx) => this.git.compact(args.repo, args.pruneNow ?? false, ctx.confirmed),
      gitTrashRepo: (args, _event, ctx) => this.git.trashRepo(args.repo, ctx.confirmed),

      toolsRefresh: () => {
        void this.tools.refreshInventory();
      },
      toolsExport: (args) => this.tools.exportInventory(args.dir),
      aiRefresh: () => {
        void this.tools.refreshAI(this.backup.states);
      },
      aiExport: () => this.tools.exportAI(),

      saveConfig: (args) => this.configs.save(args.patches),
      homeChoices: () => homeChoices(this.config().home.include),
      completePath: (args) => pathSuggestions(args.input, os.homedir()),
      onboardingDetect: async () => draftToWire(await detectDraft()),
      onboardingFinish: async (args) => {
        const config = await this.configs.finishOnboarding(args.draft);
        // Autorisation des notifications demandée maintenant, quand l'utilisateur vient de l'accepter.
        if (args.draft.notifications)
          this.notifier.post({
            title: t("onboarding.ui.notifications_ready"),
            body: t("onboarding.notifications.text"),
          });
        // Le Trousseau n'est écrit qu'après l'enregistrement de config.toml (156f978).
        const smb = config.destinations.find((d) => d.provider === "smb");
        if (smb && args.password) {
          try {
            setSmbPassword(smb, args.password);
          } catch (error) {
            this.message("warning", errorMessage(error));
          }
        }
        void this.scheduler.tick();
      },

      probeLocal: (args) => this.destinations.probeLocal(args.path),
      connectSMB: (args) => this.destinations.connectSMB(args.address, args.username, args.password ?? null),
      checkSMB: (args) => this.destinations.checkSMB(args.address, args.username, args.password ?? null),
      listShares: (args) => this.destinations.listShares(args.host, args.username, args.password ?? null),
      closeProbe: () => this.destinations.closeProbe(),
      localRoots: () => this.destinations.localRoots(),
      listFolders: (args) => this.destinations.listFolders(args.path),
      createFolder: (args) => this.destinations.createFolder(args.parent, args.name),
      addDestination: async (args) => {
        const saved = await this.destinations.add(args.destination, args.password);
        await this.configs.load();
        void this.scheduler.tick();
        return saved;
      },
      editDestination: async (args) => {
        const saved = await this.destinations.edit(args.id, args.destination, args.password);
        await this.configs.load();
        return saved;
      },
      planDestinationRemoval: (args) => this.destinations.planRemoval(args.id, args.includeBackups),
      removeDestination: async (args, _event, ctx) => {
        const r = await this.destinations.remove(args.planId, ctx.confirmed);
        await this.configs.load();
        await this.backup.reloadRunState();
        return r;
      },
      planRetention: (args) => this.destinations.planRetention(args.destination, args.retention),
      applyRetention: (args, _event, ctx) => this.destinations.applyRetention(args.planId, ctx.confirmed),

      planRestore: (args) => this.restore.plan(args),
      applyRestore: (args, _event, ctx) => this.restore.apply(args.planId, ctx.confirmed),
      createWorkspacesVolume: (_args, _event, ctx) => this.restore.createWorkspacesVolume(ctx.confirmed),
      prepareConfirmation: (args, event) => this.confirmations.issue(event.sender.id, args.method, args.args),

      checkUpdates: () => this.updates.check(true),
      installUpdate: () => this.updates.install(),

      openTarget: (args) => this.openTarget(args),
      showInFinder: (args) => this.showInFinder(args),
      openExternal: async (args) => {
        if (!allowedExternalURL(args.url)) throw new ApiError("forbidden", "URL not allowed");
        await shell.openExternal(args.url);
      },
      openPrivacySettings: async () => {
        await shell.openExternal(FULL_DISK_ACCESS_SETTINGS_URL);
      },
      copyText: (args) => clipboard.writeText(args.text),
      chooseFolder: (args) => this.chooseFolder(args.buttonLabel, args.defaultPath),
      openWindow: (args) => {
        this.menuBar?.hidePanel();
        const preselect =
          args.route === "clean" && !args.preselect ? this.analysis.cleanupPreselection : args.preselect;
        this.navigate({ ...args, ...(preselect ? { preselect } : {}) });
      },
      hidePanel: () => this.menuBar?.hidePanel(),
      dismissMessage: (args) => {
        this.messages = this.messages.filter((m) => m.id !== args.id);
        this.changed();
      },
      quit: () => {
        setImmediate(() => app.quit());
      },
    };
  }

  /** Accès des tests de bout en bout (`app.evaluate`) : jamais dans l'app empaquetée. */
  private testHooks(): Record<string, unknown> {
    return {
      tray: () => this.menuBar?.current ?? null,
      panelExists: () => this.menuBar?.panelWindow !== null,
      showPanel: () => this.menuBar?.showPanel(),
      notifications: () => this.notifier.posted,
      tick: () => this.scheduler.tick(),
      snapshot: () => this.snapshot(),
    };
  }
}
