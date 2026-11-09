import path from "node:path";
import { app, BrowserWindow, net, protocol, session, shell } from "electron";

const APP_SCHEME = "app";

// Le protocole doit être déclaré avant `ready` : origine sécurisée, pour charger l'interface sans file://.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Dossier du build (dist/), dans l'app ou dans l'asar. `__dirname` serait figé au build par le bundler. */
function distDir(): string {
  return path.join(app.getAppPath(), "dist");
}

/** Dossier des fichiers de l'interface construite (dist/renderer). */
function rendererRoot(): string {
  return path.join(distDir(), "renderer");
}

/** Sert dist/renderer sous app://cairn/…, sans sortir de ce dossier. */
function serveRenderer(): void {
  const root = rendererRoot();
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.normalize(path.join(root, relative));
    if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(`file://${file}`);
  });
}

/** Règles de sécurité communes à toutes les fenêtres. */
function lockDownContents(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://github.com/Romakita/cairn")) void shell.openExternal(url);
      return { action: "deny" };
    });
  });
}

export function createMainWindow(): BrowserWindow {
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
    webPreferences: {
      preload: path.join(distDir(), "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_SCHEME}://cairn/index.html`);
  return window;
}

/** Démarre l'interface (fenêtre principale). */
export function startInterface(_args: readonly string[]): void {
  // Tests de bout en bout : un dossier de données par test, donc un verrou d'instance par test.
  const testUserData = process.env.CAIRN_E2E_USER_DATA;
  if (testUserData) app.setPath("userData", testUserData);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.enableSandbox();
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  void app.whenReady().then(() => {
    // L'app est déclarée LSUIElement (pas de Dock en ligne de commande) : l'interface demande le Dock.
    app.setActivationPolicy("regular");
    lockDownContents();
    serveRenderer();
    createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
  app.on("window-all-closed", () => app.quit());
}
