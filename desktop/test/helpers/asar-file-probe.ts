// Sonde de test/regressions/electron-fs.test.ts : bundlée en CJS puis lancée sous le Node d'Electron
// (`ELECTRON_RUN_AS_NODE=1`). Lit le dossier donné avec le core (empreintes de la sauvegarde, mesure de l'analyse) et
// affiche le résultat en JSON. `patched` dit ce que le `fs` patché d'Electron voit de chaque fichier `.asar` (preuve
// que la sonde reproduit le bug, et pas un environnement où il n'existe pas).
import { createRequire } from "node:module";
import path from "node:path";
import { sha256File, versionFiles } from "../../src/core/backup/integrity.ts";
import { stat } from "../../src/core/fs-promises.ts";
import { measure } from "../../src/core/scanner.ts";

const [dir, ...names] = process.argv.slice(2);
if (!dir || names.length === 0) {
  console.error("usage: asar-file-probe <dossier> <fichier.asar>…");
  process.exit(2);
}

/** Ce que voit le `fs` de Node du code ordinaire (patché pour l'asar sous Electron). */
function patchedView(file: string): string {
  try {
    const nodeFs = createRequire(process.execPath)("fs") as typeof import("node:fs");
    const s = nodeFs.statSync(file);
    return s.isDirectory() ? "directory" : `file ${s.size}`;
  } catch (error) {
    return `error ${String(error)}`;
  }
}

// Bundlée en CJS : pas d'`await` au premier niveau.
async function main(): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const file = path.join(dir!, name);
    const st = await stat(file);
    out[name] = { patched: patchedView(file), isFile: st.isFile(), size: st.size, sha256: await sha256File(file) };
  }
  console.log(
    JSON.stringify({
      electron: process.versions.electron ?? null,
      asar: out,
      files: await versionFiles(dir!),
      measured: await measure(dir!),
    }),
  );
}

void main();
