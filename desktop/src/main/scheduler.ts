// Planificateur de l'app (port de BackupController.tick/notifyOverdue) : ne tourne que pendant que l'app est ouverte.
// Tour toutes les 60 s, plus au réveil, au montage d'un volume (`fs.watch('/Volumes')`), au retour du réseau (+5 s)
// et au changement d'alimentation. Veille : SIGSTOP sur les rsync, SIGCONT au réveil (via le service).
import { type FSWatcher, watch } from "node:fs";
import { net, powerMonitor } from "electron";
import { Fmt } from "../core/format.ts";
import { t } from "../core/l10n.ts";
import { OperationLock } from "../core/lock.ts";
import {
  fileRunStatePort,
  type Power,
  planTick,
  pmsetPowerSource,
  recordOverdueNotices,
} from "../core/schedule/index.ts";
import type { BackupController } from "./backup.ts";
import type { Host } from "./host.ts";

export const TICK_INTERVAL_MS = 60_000;
const NETWORK_POLL_MS = 10_000;
const NETWORK_DELAY_MS = 5000;
const VOLUME_DEBOUNCE_MS = 2000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private networkTimer: NodeJS.Timeout | null = null;
  private volumes: FSWatcher | null = null;
  private volumeDebounce: NodeJS.Timeout | null = null;
  private online: boolean | null = null;
  private ticking = false;
  private readonly cleanups: (() => void)[] = [];
  /** Dernier tour (ms). */
  lastTick: number | null = null;

  constructor(
    private readonly host: Host,
    private readonly backup: BackupController,
    /** Les tests de bout en bout désactivent les sauvegardes planifiées (jamais de vraie sauvegarde par erreur). */
    private readonly runScheduled: boolean = true,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    const on = (event: string, listener: () => void) => {
      powerMonitor.on(event as "suspend", listener);
      this.cleanups.push(() => powerMonitor.removeListener(event as "suspend", listener));
    };
    on("suspend", () => this.backup.suspend());
    on("resume", () => {
      this.backup.resume();
      void this.tick();
    });
    on("on-ac", () => void this.tick());
    on("on-battery", () => void this.tick());
    try {
      this.volumes = watch("/Volumes", () => this.volumeChanged());
      this.volumes.on("error", () => {});
    } catch {
      this.volumes = null;
    }
    this.networkTimer = setInterval(() => this.pollNetwork(), NETWORK_POLL_MS);
    this.pollNetwork();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.networkTimer) clearInterval(this.networkTimer);
    if (this.volumeDebounce) clearTimeout(this.volumeDebounce);
    this.volumes?.close();
    for (const c of this.cleanups.splice(0)) c();
    this.timer = null;
    this.networkTimer = null;
  }

  private volumeChanged(): void {
    if (this.volumeDebounce) clearTimeout(this.volumeDebounce);
    this.volumeDebounce = setTimeout(() => void this.tick(), VOLUME_DEBOUNCE_MS);
  }

  private pollNetwork(): void {
    const now = net.isOnline();
    if (this.online === false && now) setTimeout(() => void this.tick(), NETWORK_DELAY_MS);
    this.online = now;
  }

  private async power(): Promise<Power> {
    const power = await pmsetPowerSource();
    // `powerMonitor` est la source la plus directe pour « sur batterie » ; `pmset` donne le pourcentage et le mode.
    return { ...power, onBattery: powerMonitor.isOnBatteryPower() };
  }

  /** Vérifie chaque destination : sauvegarde due, alimentation, joignabilité, retard à signaler. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.lastTick = Date.now();
      const config = this.host.config();
      if (config.destinations.length === 0) return;
      const reachable = await this.backup.probeReachability(config.destinations);
      const locked = await OperationLock.isHeld({ stateDir: this.host.paths.state }).catch(() => false);
      await this.backup.reloadRunState();
      const plan = planTick({
        destinationIds: config.destinations.map((d) => d.id),
        schedule: config.schedule,
        state: this.backup.states.destinations,
        reachable,
        power: await this.power(),
        now: new Date(),
        running: this.backup.running || locked,
        configInvalid: this.host.configInvalid(),
      });
      if (Object.keys(plan.waiting).length > 0) {
        this.backup.waiting = plan.waiting;
        this.host.changed();
      }
      // Relu juste avant l'écriture de la notice (46a9475).
      await recordOverdueNotices(
        fileRunStatePort(this.host.paths),
        { schedule: config.schedule, waiting: plan.waiting, now: new Date() },
        (id, lastSuccess) => {
          const d = config.destinations.find((x) => x.id === id);
          const label = d ? this.host.destinationLabel(d) : id;
          const body = t("backup.notify.overdue_body", lastSuccess ? Fmt.date(lastSuccess) : "—");
          this.host.notifier.postWithLog(t("backup.notify.overdue_title", label), body, null);
        },
      ).catch(() => []);
      if (plan.due.length > 0 && this.runScheduled) {
        await this.backup.start({ destinations: plan.due }, { scheduled: true }).catch((error) => {
          this.host.message("error", error instanceof Error ? error.message : String(error));
        });
      }
    } finally {
      this.ticking = false;
    }
  }
}
