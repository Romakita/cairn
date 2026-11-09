// Barre des menus (port de MenuBarExtra + MenuBarPanel) : icône « template » selon l'état global (même niveau que
// l'accueil), animée pendant une sauvegarde (0,6 s par image), et petit panneau sans cadre sous l'icône (même preload
// et même API que la fenêtre principale, route `#/menubar`), masqué quand il perd le focus. Le panneau ne lance
// jamais d'action destructive.
import path from "node:path";
import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";
import type { HealthLevel } from "../core/health.ts";
import { t } from "../core/l10n.ts";
import { APP_ORIGIN } from "../shared/contract.ts";
import { windowSecurity } from "./interface.ts";

export type TrayState = "normal" | "running" | "attention" | "error";

const FRAME_MS = 600;
const RUNNING_FRAMES = 4;
/** Largeur du panneau (spec : 360, comme la 0.8.0). */
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 480;

function iconDir(): string {
  return path.join(app.getAppPath(), "resources/tray");
}

/** Image « template » (noir + transparence) ; `@2x` est chargée automatiquement. */
function icon(name: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(path.join(iconDir(), `${name}Template.png`));
  image.setTemplateImage(true);
  return image;
}

export function trayState(overall: HealthLevel, running: boolean): TrayState {
  if (running) return "running";
  return overall === "ok" ? "normal" : overall;
}

export interface TrayActions {
  openMain(): void;
  quit(): void;
}

export class MenuBar {
  private readonly tray: Tray;
  private panel: BrowserWindow | null = null;
  private state: TrayState | null = null;
  private frame = 0;
  private animation: NodeJS.Timeout | null = null;
  private readonly images = new Map<string, Electron.NativeImage>();
  private hiddenAt = 0;

  constructor(
    private readonly preload: string,
    private readonly actions: TrayActions,
  ) {
    this.tray = new Tray(this.image("normal"));
    this.tray.setToolTip("Cairn");
    this.tray.on("click", () => this.togglePanel());
    this.tray.on("right-click", () => this.tray.popUpContextMenu(this.menu()));
  }

  private image(name: string): Electron.NativeImage {
    let image = this.images.get(name);
    if (!image) {
      image = icon(name);
      this.images.set(name, image);
    }
    return image;
  }

  private menu(): Menu {
    return Menu.buildFromTemplate([
      { label: t("menu.open"), click: () => this.actions.openMain() },
      { type: "separator" },
      { label: t("menu.quit"), click: () => this.actions.quit() },
    ]);
  }

  get current(): TrayState | null {
    return this.state;
  }

  /** Icône selon l'état ; l'animation ne tourne que pendant une sauvegarde. */
  update(state: TrayState): void {
    if (state === this.state) return;
    this.state = state;
    if (this.animation) clearInterval(this.animation);
    this.animation = null;
    if (state === "running") {
      this.frame = 0;
      this.tray.setImage(this.image("running-0"));
      this.animation = setInterval(() => {
        this.frame = (this.frame + 1) % RUNNING_FRAMES;
        this.tray.setImage(this.image(`running-${this.frame}`));
      }, FRAME_MS);
    } else {
      this.tray.setImage(this.image(state));
    }
  }

  private createPanel(): BrowserWindow {
    const panel = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      hasShadow: true,
      vibrancy: "popover",
      visualEffectState: "active",
      backgroundColor: "#00000000",
      webPreferences: windowSecurity(this.preload),
    });
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    panel.on("blur", () => {
      if (!panel.webContents.isDevToolsOpened()) this.hidePanel();
    });
    panel.on("closed", () => {
      this.panel = null;
    });
    void panel.loadURL(`${APP_ORIGIN}/index.html#/menubar`);
    return panel;
  }

  /** Panneau sous l'icône, dans les limites de l'écran. */
  showPanel(): void {
    this.panel ??= this.createPanel();
    const bounds = this.tray.getBounds();
    const display = screen.getDisplayMatching(bounds).workArea;
    const x = Math.round(
      Math.min(
        Math.max(bounds.x + bounds.width / 2 - PANEL_WIDTH / 2, display.x + 4),
        display.x + display.width - PANEL_WIDTH - 4,
      ),
    );
    const y = Math.round(bounds.y + bounds.height + 4);
    this.panel.setPosition(x, y, false);
    this.panel.show();
    this.panel.focus();
  }

  hidePanel(): void {
    if (this.panel?.isVisible()) {
      this.panel.hide();
      this.hiddenAt = Date.now();
    }
  }

  togglePanel(): void {
    // Un clic sur l'icône pendant que le panneau a le focus le masque d'abord (blur) : ne pas le rouvrir aussitôt.
    if (this.panel?.isVisible()) this.hidePanel();
    else if (Date.now() - this.hiddenAt > 250) this.showPanel();
  }

  get panelWindow(): BrowserWindow | null {
    return this.panel;
  }

  destroy(): void {
    if (this.animation) clearInterval(this.animation);
    this.panel?.destroy();
    this.tray.destroy();
  }
}
