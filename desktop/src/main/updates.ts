// Mises à jour de l'app (port de UpdateController.swift) : contrôle 5 s après le lancement puis toutes les 6 h si
// `[updates] check`, contrôle manuel, installation (téléchargement vérifié par le core, script de remplacement, puis
// fermeture). Refusée pendant une sauvegarde : la raison est recalculée à chaque état, donc l'installation redevient
// possible dès la fin de la sauvegarde (0f7a1ce). Hors d'un `.app` remplaçable, seule la page de la release s'ouvre.
import { app, shell } from "electron";
import { t } from "../core/l10n.ts";
import {
  type AppRelease,
  bundleOf,
  CHECK_INTERVAL_MS,
  checkForUpdate,
  downloadRelease,
  FIRST_CHECK_DELAY_MS,
  installableBundle,
  latestURL,
  RELEASES_PAGE,
  scheduleSwap,
} from "../core/updater.ts";
import { CAIRN_VERSION } from "../core/version.ts";
import type { UpdatePhase, UpdateView } from "../shared/contract.ts";
import { errorMessage } from "./errors.ts";
import type { Host } from "./host.ts";

export class UpdateController {
  private available: AppRelease | null = null;
  private phase: UpdatePhase = "idle";
  private error: string | null = null;
  private message: string | null = null;
  private lastCheck: number | null = null;
  private bundle: string | null = null;
  private first: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: Host,
    /** Fermeture propre de l'app une fois le remplacement programmé. */
    private readonly quit: () => void,
  ) {}

  async start(): Promise<void> {
    // Bundle remplaçable : l'app empaquetée dont le dossier parent est modifiable (rien en développement).
    this.bundle = app.isPackaged ? await installableBundle(bundleOf(process.execPath)) : null;
    this.first = setTimeout(() => this.automaticCheck(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => this.automaticCheck(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  private automaticCheck(): void {
    if (!this.host.config().checkUpdates) return;
    void this.check(false);
  }

  /** Contrôle : silencieux en automatique, message à l'utilisateur en manuel. */
  async check(manual: boolean): Promise<void> {
    if (this.phase === "checking" || this.phase === "downloading") return;
    this.phase = "checking";
    this.message = null;
    this.host.changed();
    try {
      this.available = await checkForUpdate({ current: CAIRN_VERSION });
      this.phase = "idle";
      this.error = null;
      if (manual && !this.available) this.message = t("update.up_to_date", CAIRN_VERSION);
    } catch (error) {
      this.phase = "idle";
      if (manual) this.error = errorMessage(error);
    }
    this.lastCheck = Date.now();
    this.host.changed();
  }

  /** Raison pour laquelle l'installation est impossible maintenant, sinon `null` (suit la sauvegarde en direct). */
  blocker(): string | null {
    if (this.host.isBackingUp()) return t("update.blocked.backup");
    if (!this.bundle) return t("update.blocked.not_installable");
    return null;
  }

  /** Télécharge et vérifie la release, programme le remplacement du bundle puis quitte (le script relance l'app). */
  async install(): Promise<void> {
    const r = this.available;
    if (!r || this.phase === "downloading") return;
    const bundle = this.bundle;
    if (!bundle) {
      // Copie non remplaçable : la page de la release.
      await shell.openExternal(r.pageURL.startsWith("https://") ? r.pageURL : RELEASES_PAGE);
      return;
    }
    const blocked = this.blocker();
    if (blocked) {
      this.phase = "failed";
      this.error = blocked;
      this.host.changed();
      return;
    }
    this.phase = "downloading";
    this.error = null;
    this.host.changed();
    try {
      // Flux de test (`CAIRN_UPDATE_URL` en http local) : adresses http acceptées pour ce flux seulement.
      const insecure = latestURL().startsWith("http://");
      const newApp = await downloadRelease(r, bundle, { current: CAIRN_VERSION, allowInsecure: insecure });
      // Une sauvegarde lancée pendant le téléchargement l'emporte.
      const late = this.blocker();
      if (late) {
        this.phase = "failed";
        this.error = late;
        this.host.changed();
        return;
      }
      scheduleSwap({ newApp, bundle, pid: process.pid, relaunch: true });
      this.quit();
    } catch (error) {
      this.phase = "failed";
      this.error = errorMessage(error);
      this.host.changed();
    }
  }

  view(): UpdateView {
    const r = this.available;
    return {
      current: CAIRN_VERSION,
      available: r ? { version: r.version, notes: r.notes, pageURL: r.pageURL } : null,
      phase: this.phase,
      error: this.error,
      blocker: this.blocker(),
      installable: this.bundle !== null,
      lastCheck: this.lastCheck,
      message: this.message,
    };
  }
}
