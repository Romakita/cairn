import { app } from "electron";
import { isCommandLine } from "../cli/dispatch.ts";
import { cliContextForApp, runCli } from "../cli/index.ts";
import { parseGalleryArgs, runGallery } from "./gallery.ts";
import { startInterface } from "./interface.ts";
import { loadNativeModule } from "./native-loader.ts";

// Arguments utiles : sans l'exécutable, et sans le dossier de l'app quand on lance `electron .` en développement.
const args = process.argv.slice(app.isPackaged ? 1 : 2);

/** Écrit sur un flux et attend la vidange : une sortie dans un pipe n'est pas tronquée par la sortie du process. */
function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!stream.write(`${text}\n`)) stream.once("drain", resolve);
    else resolve();
  });
}

// Module natif chargé avant l'aiguillage : la CLI (verrou, Trousseau) et l'interface en ont besoin. Un échec n'empêche
// pas l'app de démarrer : le message est gardé et affiché, les opérations qui en dépendent échouent clairement.
const nativeError = loadNativeModule();

// Galerie des composants avant l'aiguillage CLI (comme main.swift) : `--gallery`, `--gallery-export <dossier>`.
const gallery = parseGalleryArgs(args);

if (gallery) {
  runGallery(gallery);
} else if (isCommandLine(args)) {
  // Même exécutable que l'interface : pas de fenêtre, pas de Dock (LSUIElement), pas de verrou d'instance.
  app.commandLine.appendSwitch("log-level", "3");
  const pending: Promise<void>[] = [];
  const io = {
    out: (t: string) => void pending.push(write(process.stdout, t)),
    err: (t: string) => void pending.push(write(process.stderr, t)),
  };
  if (nativeError) io.err(`cairn: ${nativeError}`);
  // Langues du système pour `language = "auto"` : disponibles avant `ready`.
  const context = cliContextForApp(app.getAppPath(), app.getPreferredSystemLanguages());
  runCli(args, io, context)
    .catch(async (error: unknown) => {
      await write(process.stderr, `cairn: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    })
    .then(async (code) => {
      await Promise.all(pending);
      app.exit(code);
    });
} else {
  startInterface({ args, nativeError });
}
