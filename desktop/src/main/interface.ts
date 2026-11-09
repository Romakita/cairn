import path from "node:path";
import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import { APP_ORIGIN } from "../shared/contract.ts";
import { CairnApp } from "./app.ts";

const APP_SCHEME = "app";

// Le protocole doit être déclaré avant `ready` : origine sécurisée, pour charger l'interface sans file://.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Dossier du build (dist/), dans l'app ou dans l'asar. `__dirname` serait figé au build par le bundler. */
export function distDir(): string {
  return path.join(app.getAppPath(), "dist");
}

/** Dossier des fichiers de l'interface construite (dist/renderer). */
function rendererRoot(): string {
  return path.join(distDir(), "renderer");
}

/** Sert dist/renderer sous app://cairn/…, sans sortir de ce dossier (interface et galerie). */
export function serveRenderer(): void {
  const root = rendererRoot();
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.normalize(path.join(root, relative));
    if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(`file://${file}`);
  });
}

/** Liens externes autorisés (`shell.openExternal`) : le dépôt et ses releases. */
export function allowedExternalURL(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host === "github.com" && /^\/Romakita\/cairn(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Règles de sécurité communes à toutes les fenêtres. */
function lockDownContents(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedExternalURL(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  });
}

/** Préférences de toutes les fenêtres de l'interface (fenêtre principale, panneau de la barre des menus). */
export function windowSecurity(preload: string): Electron.WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  };
}

export function preloadPath(): string {
  return path.join(distDir(), "preload.cjs");
}

export function createMainWindow(hash = ""): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    webPreferences: windowSecurity(preloadPath()),
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_ORIGIN}/index.html${hash}`);
  return window;
}

export interface InterfaceOptions {
  args: readonly string[];
  /** Échec du chargement du module natif (affiché, sans empêcher l'app de démarrer). */
  nativeError: string | null;
}

/** Démarre l'interface (fenêtre principale, barre des menus, planificateur). */
export function startInterface(options: InterfaceOptions): void {
  // Tests de bout en bout : un dossier de données par test, donc un verrou d'instance par test.
  const testUserData = process.env.CAIRN_E2E_USER_DATA;
  if (testUserData) app.setPath("userData", testUserData);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.enableSandbox();
  void app.whenReady().then(async () => {
    // L'app est déclarée LSUIElement (pas de Dock en ligne de commande) : l'interface demande le Dock.
    app.setActivationPolicy("regular");
    lockDownContents();
    serveRenderer();
    const cairn = new CairnApp({ nativeError: options.nativeError });
    await cairn.start();
  });
}
