// Captures des écrans de l'app (spec interface-design, « Vérification visuelle des écrans ») : chaque écran avec
// l'API d'exemple, en clair et en sombre, dans shots/screens/<nom>-<light|dark>.png, plus un index.html.
// Usage : bun scripts/screen-shots.ts [préfixe…]   (ex. `backup.` pour une zone)
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startDevServer } from "./dev-web.ts";
import { shots as ai } from "./shots/ai.ts";
import { shots as backup } from "./shots/backup.ts";
import { shots as git } from "./shots/git.ts";
import { shots as home } from "./shots/home.ts";
import { shots as menubar } from "./shots/menubar.ts";
import { shots as restore } from "./shots/restore.ts";
import { shots as settings } from "./shots/settings.ts";
import { shots as shell } from "./shots/shell.ts";
import { shots as storage } from "./shots/storage.ts";
import { shots as tools } from "./shots/tools.ts";
import type { ScreenShot } from "./shots/types.ts";

const ALL: ScreenShot[] = [
  ...shell,
  ...home,
  ...storage,
  ...backup,
  ...restore,
  ...git,
  ...tools,
  ...ai,
  ...settings,
  ...menubar,
];
const SAFE = /^[a-z0-9._-]+$/;

const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, "shots", "screens");
const filters = process.argv.slice(2);
const selected = ALL.filter((s) => filters.length === 0 || filters.some((f) => s.name.startsWith(f)));

function url(base: string, shot: ScreenShot): string {
  const query = new URLSearchParams({ scenario: shot.scenario ?? "normal" });
  if (shot.at !== undefined) {
    query.set("t", String(shot.at));
    query.set("frozen", "1");
  }
  if (shot.lang === "fr") query.set("lang", "fr");
  return `${base}/?${query}${shot.hash}`;
}

const server = await startDevServer({ port: 5175, watch: false, quiet: true });
const browser = await chromium.launch();
const errors: string[] = [];
try {
  if (filters.length === 0) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const shot of selected) {
    if (!SAFE.test(shot.name)) throw new Error(`nom de capture refusé : ${shot.name}`);
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({
        viewport: shot.viewport ?? { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      page.on("pageerror", (error) => errors.push(`${shot.name} (${theme}) : ${error.message}`));
      await page.goto(url(server.url, shot));
      await page.waitForLoadState("networkidle");
      if (shot.before) await shot.before(page);
      await page.screenshot({ path: path.join(outDir, `${shot.name}-${theme}.png`), animations: "disabled" });
      await page.close();
    }
  }
  const rows = ALL.map(
    (s) =>
      `<tr><td>${s.name}</td><td><img src="${s.name}-light.png" width="640"></td><td><img src="${s.name}-dark.png" width="640"></td></tr>`,
  ).join("\n");
  await writeFile(
    path.join(outDir, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Cairn screens</title><table>${rows}</table>`,
  );
  console.log(`${selected.length * 2} captures dans ${path.relative(process.cwd(), outDir)}`);
} finally {
  await browser.close();
  server.stop();
}
for (const e of errors) console.error(`Erreur de page : ${e}`);
if (errors.length > 0) process.exit(1);
