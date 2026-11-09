// Captures de l'interface sans Electron : sert le renderer (dev-web), l'ouvre dans Chromium (Playwright) et écrit
// une image par cible et par thème dans shots/<ensemble>/, avec un index.html. Aujourd'hui : la galerie ;
// les écrans d'exemple s'ajouteront à `SETS` (même plan de capture que `cairn --gallery-export`).
//
//   bun run shots                 → shots/gallery/<story>-<light|dark>.png + index.html
//   bun run shots -- gallery buttons.pill   (filtre sur les noms)
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import {
  CAPTURE_THEMES,
  type CaptureRect,
  type CaptureTarget,
  captureIndexHtml,
  galleryTargets,
  type ManifestEntry,
  readManifestScript,
  SAFE_NAME,
  showAndMeasureScript,
} from "../src/renderer/gallery/capture.ts";
import { startDevServer } from "./dev-web.ts";

const root = path.resolve(import.meta.dir, "..");

/** Ensemble de captures : dossier de sortie, cibles et page d'index. */
interface CaptureSet {
  name: string;
  /** Page d'où lire la liste des cibles. */
  entryHash: string;
  targets: (page: Page) => Promise<{ entries: ManifestEntry[]; targets: CaptureTarget[] }>;
  title: string;
  subtitle: string;
}

const SETS: CaptureSet[] = [
  {
    name: "gallery",
    entryHash: "#/gallery?capture",
    title: "Cairn components",
    subtitle: "Each story in light and dark.",
    async targets(page) {
      const entries = (await page.evaluate(readManifestScript())) as ManifestEntry[];
      return { entries, targets: CAPTURE_THEMES.flatMap((theme) => galleryTargets(entries, theme)) };
    },
  },
];

async function capture(page: Page, target: CaptureTarget, file: string): Promise<void> {
  const rect = (await page.evaluate(showAndMeasureScript(target))) as CaptureRect;
  await page.screenshot({ path: file, clip: rect, animations: "disabled" });
}

const [setFilter, ...nameFilters] = process.argv.slice(2);
const server = await startDevServer({ port: 5174, watch: false, quiet: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(`Erreur de page : ${error.message}`));
  for (const set of SETS.filter((s) => !setFilter || s.name === setFilter)) {
    const outDir = path.join(root, "shots", set.name);
    await page.goto(`${server.url}/${set.entryHash}`);
    const { entries, targets } = await set.targets(page);
    const selected = targets.filter((t) => nameFilters.length === 0 || nameFilters.some((f) => t.name.startsWith(f)));
    if (nameFilters.length === 0) await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    for (const target of selected) {
      if (!SAFE_NAME.test(target.name)) throw new Error(`nom de capture refusé : ${target.name}`);
      await capture(page, target, path.join(outDir, `${target.name}.png`));
    }
    await writeFile(path.join(outDir, "index.html"), captureIndexHtml(set.title, set.subtitle, entries));
    console.log(`${selected.length} captures et index.html dans ${path.relative(process.cwd(), outDir) || outDir}`);
  }
} finally {
  await browser.close();
  server.stop();
}
