// Lancement par un lien hors de l'app (`~/.local/bin/cairn` → `Cairn.app/Contents/MacOS/Cairn`) : Chromium cherche
// ses processus auxiliaires (GPU, réseau, rendu) à côté du chemin du LIEN et ne les trouve pas (« Unable to find
// helper app »). On relance donc l'exécutable par son vrai chemin, avant toute initialisation de Chromium.
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

/** Chemin par lequel l'exécutable a été lancé (`argv0`), résolu dans le PATH s'il n'a pas de `/`. */
export function launchedPath(argv0: string, envPath: string | undefined): string | null {
  if (argv0.includes("/")) return path.resolve(argv0);
  for (const dir of (envPath ?? "").split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, argv0);
    try {
      realpathSync(candidate);
      return candidate;
    } catch {
      // absent de ce dossier
    }
  }
  return null;
}

/** Vrai si l'exécutable a été lancé par un autre chemin (lien) qui mène pourtant au même fichier. */
export function launchedThroughLink(argv0: string, execPath: string, envPath: string | undefined): boolean {
  const launched = launchedPath(argv0, envPath);
  if (!launched || launched === execPath) return false;
  try {
    return realpathSync(launched) === realpathSync(execPath);
  } catch {
    return false;
  }
}

/**
 * Relance l'exécutable par son vrai chemin si l'app empaquetée a été lancée par un lien. Renvoie `true` si une
 * relance a eu lieu : l'appelant doit alors s'arrêter avec `exit(code)`.
 * - Ligne de commande : relance synchrone, même entrée/sortie, même code de sortie.
 * - Interface : relance détachée, puis ce process s'arrête.
 */
export function relaunchFromRealPath(options: {
  packaged: boolean;
  commandLine: boolean;
  exit: (code: number) => void;
}): boolean {
  if (!options.packaged) return false;
  if (!launchedThroughLink(process.argv0, process.execPath, process.env.PATH)) return false;
  const args = process.argv.slice(1);
  if (options.commandLine) {
    const result = spawnSync(process.execPath, args, { stdio: "inherit" });
    options.exit(result.status ?? 1);
  } else {
    spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
    options.exit(0);
  }
  return true;
}
