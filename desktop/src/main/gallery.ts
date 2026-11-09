// Catalogue des composants : `cairn --gallery` (fenêtre) et `cairn --gallery-export <dossier>` (une image par story
// et par thème + index.html, écrits uniquement dans ce dossier). Branché dans main.ts avant l'aiguillage CLI,
// comme dans main.swift. La galerie n'utilise pas le preload : la fenêtre n'en charge aucun.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { t } from "../core/l10n.ts";
import {
  CAPTURE_THEMES,
  type CaptureRect,
  captureIndexHtml,
  galleryTargets,
  type ManifestEntry,
  readManifestScript,
  SAFE_NAME,
  showAndMeasureScript,
} from "../renderer/gallery/capture.ts";
import { s } from "../renderer/gallery/sample-text.ts";
import { serveRenderer } from "./interface.ts";

export type GalleryRequest = { mode: "window" } | { mode: "export"; dir: string } | { mode: "usage" };

/** `--gallery` ou `--gallery-export <dossier>` parmi les arguments ; `null` sinon. */
export function parseGalleryArgs(args: readonly string[]): GalleryRequest | null {
  const index = args.indexOf("--gallery-export");
  if (index >= 0) {
    const dir = args[index + 1];
    return dir && !dir.startsWith("-") ? { mode: "export", dir } : { mode: "usage" };
  }
  return args.includes("--gallery") ? { mode: "window" } : null;
}

const GALLERY_URL = "app://cairn/index.html#/gallery";

function galleryWindow(show: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: show ? 1280 : 1400,
    height: show ? 800 : 1000,
    minWidth: 900,
    minHeight: 600,
    show: false,
    paintWhenInitiallyHidden: true,
    titleBarStyle: show ? "hiddenInset" : undefined,
    backgroundColor: "#ffffff",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (show) window.once("ready-to-show", () => window.show());
  return window;
}

/** Exporte chaque story en clair et en sombre dans `dir` ; renvoie le nombre d'images. */
export async function exportGallery(dir: string): Promise<number> {
  const out = path.resolve(dir);
  await mkdir(out, { recursive: true });
  const window = galleryWindow(false);
  try {
    await window.loadURL(`${GALLERY_URL}?capture`);
    const entries = (await window.webContents.executeJavaScript(readManifestScript())) as ManifestEntry[];
    let count = 0;
    for (const theme of CAPTURE_THEMES) {
      for (const target of galleryTargets(entries, theme)) {
        const file = path.join(out, `${target.name}.png`);
        if (!SAFE_NAME.test(target.name) || path.dirname(file) !== out) throw new Error(`invalid name: ${target.name}`);
        const rect = (await window.webContents.executeJavaScript(showAndMeasureScript(target))) as CaptureRect;
        const image = await window.webContents.capturePage(rect);
        if (image.isEmpty()) throw new Error(`empty capture: ${target.name}`);
        await writeFile(file, image.toPNG());
        count += 1;
      }
    }
    const index = captureIndexHtml(t("gallery.window.title"), s("gallery.export.subtitle_themes"), entries);
    await writeFile(path.join(out, "index.html"), index);
    return count;
  } finally {
    window.destroy();
  }
}

function writeLine(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!stream.write(`${text}\n`)) stream.once("drain", resolve);
    else resolve();
  });
}

/** Lance la galerie demandée : fenêtre (l'app reste ouverte) ou export (l'app quitte avec un code). */
export function runGallery(request: GalleryRequest): void {
  const testUserData = process.env.CAIRN_E2E_USER_DATA;
  if (testUserData) app.setPath("userData", testUserData);
  if (request.mode === "usage") {
    void writeLine(process.stderr, t("gallery.export.usage")).then(() => app.exit(2));
    return;
  }
  app.enableSandbox();
  if (request.mode === "export") app.dock?.hide();
  void app.whenReady().then(async () => {
    serveRenderer();
    if (request.mode === "window") {
      app.setActivationPolicy("regular");
      void galleryWindow(true).loadURL(GALLERY_URL);
      app.on("window-all-closed", () => app.quit());
      return;
    }
    try {
      const count = await exportGallery(request.dir);
      await writeLine(process.stdout, t("gallery.export.done", count, path.resolve(request.dir)));
      app.exit(0);
    } catch (error) {
      await writeLine(process.stderr, `cairn: ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    }
  });
}
