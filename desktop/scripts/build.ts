// Construit dist/ : main et preload (CommonJS, Node d'Electron), interface (navigateur).
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");
const production = process.env.NODE_ENV === "production" || process.argv.includes("--production");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "renderer"), { recursive: true });

async function bundle(options: Parameters<typeof Bun.build>[0]): Promise<void> {
  const result = await Bun.build({ minify: production, sourcemap: production ? "none" : "linked", ...options });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

const define = { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") };

await bundle({
  entrypoints: [path.join(root, "src/main/main.ts")],
  outdir: dist,
  target: "node",
  format: "cjs",
  external: ["electron", "*.node"],
  naming: "[name].cjs",
  define,
});

// Worker de l'analyse git (worker_threads) : fichier séparé, chargé par le pool avec son chemin dans dist/.
await bundle({
  entrypoints: [path.join(root, "src/core/git/worker.ts")],
  outdir: dist,
  target: "node",
  format: "cjs",
  external: ["electron", "*.node"],
  naming: "git-worker.cjs",
  define,
});

await bundle({
  entrypoints: [path.join(root, "src/preload/preload.ts")],
  outdir: dist,
  target: "node",
  format: "cjs",
  external: ["electron"],
  naming: "[name].cjs",
  define,
});

await bundle({
  entrypoints: [path.join(root, "src/renderer/main.tsx")],
  outdir: path.join(dist, "renderer"),
  target: "browser",
  format: "esm",
  define,
});

await cp(path.join(root, "src/renderer/index.html"), path.join(dist, "renderer/index.html"));
console.log(`dist/ construit (${production ? "production" : "développement"})`);
