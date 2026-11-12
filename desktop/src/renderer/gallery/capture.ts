// Plan de capture commun à `bun run shots` (Playwright) et à `cairn --gallery-export` (fenêtre Electron) :
// adresses des stories, attente du rendu, noms de fichiers et page d'index. Aucune dépendance au DOM ni à Node.

export const CAPTURE_THEMES = ["light", "dark"] as const;
export type CaptureTheme = (typeof CAPTURE_THEMES)[number];

/** Story telle que la galerie la décrit dans `data-gallery-manifest`. */
export interface ManifestEntry {
  id: string;
  group: string;
  groupTitle: string;
  title: string;
  component: string;
}

/** Une page à capturer : adresse (hash) et nom de fichier, sans extension. Les écrans s'ajouteront à cette liste. */
export interface CaptureTarget {
  name: string;
  hash: string;
  /** Élément à capturer. */
  selector: string;
}

/** Nom de fichier sûr : identifiant de story ou d'écran, jamais de séparateur de chemin. */
export const SAFE_NAME = /^[a-z0-9_.-]+$/;

export function galleryTargets(entries: readonly ManifestEntry[], theme: CaptureTheme): CaptureTarget[] {
  return entries.map((e) => ({
    name: `${e.id}-${theme}`,
    hash: `#/gallery/${encodeURIComponent(e.id)}?theme=${theme}&capture`,
    selector: `[data-story-id="${e.id}"]`,
  }));
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Exécutée dans la page : affiche `hash`, attend l'élément, les polices et la fin des animations courtes, puis
 * renvoie son rectangle. Autonome (sérialisée telle quelle pour `executeJavaScript`).
 */
export async function showAndMeasure(hash: string, selector: string): Promise<CaptureRect> {
  if (location.hash !== hash) location.hash = hash;
  const theme = /theme=dark/.test(hash) ? "dark" : "light";
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 300; i += 1) {
    if (document.querySelector(selector) && document.documentElement.dataset.theme === theme) break;
    await wait(10);
  }
  await document.fonts.ready;
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await frames();
  // Fin des animations et transitions qui en ont une (un indicateur d'activité tourne sans fin), au plus 1 s : une
  // pause fixe par image rendait l'export de la galerie trop lent.
  const finite = document
    .getAnimations()
    .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY)));
  await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => undefined))), wait(1000)]);
  await frames();
  const el = document.querySelector(selector);
  if (!el) throw new Error(`introuvable : ${selector}`);
  const r = el.getBoundingClientRect();
  return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
}

/** Script de `showAndMeasure` pour `webContents.executeJavaScript`. */
export function showAndMeasureScript(target: CaptureTarget): string {
  return `(${showAndMeasure.toString()})(${JSON.stringify(target.hash)}, ${JSON.stringify(target.selector)})`;
}

/** Lit la liste des stories dans la page de la galerie (exécutée dans la page). */
export async function readManifest(): Promise<ManifestEntry[]> {
  for (let i = 0; i < 300; i += 1) {
    const raw = document.querySelector("[data-gallery-manifest]")?.getAttribute("data-gallery-manifest");
    if (raw) return JSON.parse(raw) as ManifestEntry[];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("galerie introuvable");
}

export function readManifestScript(): string {
  return `(${readManifest.toString()})()`;
}

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Page `index.html` autonome : une section par groupe, une ligne par story avec ses images en clair et en sombre.
 * Couleurs système CSS (Canvas, CanvasText) : la page suit le thème du lecteur sans couleur codée en dur.
 */
export function captureIndexHtml(title: string, subtitle: string, entries: readonly ManifestEntry[]): string {
  const groups: string[] = [];
  for (const group of [...new Set(entries.map((e) => e.group))]) {
    const items = entries.filter((e) => e.group === group);
    const articles = items
      .map((e) => {
        const figures = CAPTURE_THEMES.map(
          (theme) =>
            `<figure><img src="${esc(`${e.id}-${theme}.png`)}" alt="${esc(e.id)}" loading="lazy"><figcaption>${theme}</figcaption></figure>`,
        ).join("");
        return `<article id="${esc(e.id)}"><h3>${esc(e.title)} <code>${esc(e.component)}</code></h3><div class="grid">${figures}</div></article>`;
      })
      .join("\n");
    groups.push(`<section><h2>${esc(items[0]!.groupTitle)}</h2>\n${articles}</section>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 32px 16px; background: Canvas; color: CanvasText; font: 14px -apple-system, system-ui, sans-serif; }
main { max-width: 1400px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 40px 0 8px; }
h3 { font-size: 14px; font-weight: 500; margin: 24px 0 8px; } code, p, figcaption { color: GrayText; }
code { font-size: 12px; } p { margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; align-items: start; }
figure { margin: 0; border: 1px solid GrayText; border-radius: 12px; overflow: hidden; }
img { display: block; max-width: 100%; height: auto; }
figcaption { padding: 6px 10px; font-size: 11px; border-top: 1px solid GrayText; }
</style>
</head>
<body><main>
<h1>${esc(title)}</h1>
<p>${esc(subtitle)}</p>
${groups.join("\n")}
</main></body>
</html>
`;
}
