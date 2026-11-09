// Rend les icônes de la barre des menus (images « template » : noir et transparence) depuis les SVG de ce dossier.
// À relancer après une modification d'un SVG, puis à valider (les PNG sont versionnés) :
//
//   node_modules/.bin/electron resources/tray/render-icons.mjs
//
// Sorties : <état>Template.png (18 px) et <état>Template@2x.png (36 px). États : normal (logo), attention, error,
// running-0…3 (flèches de refresh-cw tournées de 45° par image, animation de 0,6 s par image).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";

const dir = path.dirname(new URL(import.meta.url).pathname);
const SIZE = 18;

const ICONS = [
  { name: "normal", file: "cairn-logo.svg", rotate: 0 },
  { name: "attention", file: "lucide-triangle-alert.svg", rotate: 0 },
  { name: "error", file: "lucide-octagon-x.svg", rotate: 0 },
  { name: "running-0", file: "lucide-refresh-cw.svg", rotate: 0 },
  { name: "running-1", file: "lucide-refresh-cw.svg", rotate: 45 },
  { name: "running-2", file: "lucide-refresh-cw.svg", rotate: 90 },
  { name: "running-3", file: "lucide-refresh-cw.svg", rotate: 135 },
];

function page(svg, px, rotate) {
  const sized = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/width="24"/, `width="${px}"`)
    .replace(/height="24"/, `height="${px}"`)
    .replace(/currentColor/g, "#000");
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;transform:rotate(${rotate}deg)}
  </style></head><body>${sized}</body></html>`;
}

async function render(win, svg, px, rotate) {
  win.setContentSize(px, px);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(svg, px, rotate))}`);
  await new Promise((r) => setTimeout(r, 150));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: px, height: px });
  return image.resize({ width: px, height: px }).toPNG();
}

app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 36,
    height: 36,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  win.webContents.setFrameRate(1);
  for (const icon of ICONS) {
    const svg = await readFile(path.join(dir, icon.file), "utf8");
    for (const scale of [1, 2]) {
      const png = await render(win, svg, SIZE * scale, icon.rotate);
      const out = path.join(dir, `${icon.name}Template${scale === 2 ? "@2x" : ""}.png`);
      await writeFile(out, png);
      console.log(out);
    }
  }
  app.exit(0);
});
