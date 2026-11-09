// Chargement du module natif (Trousseau, montage SMB, flock, espace libre APFS) au démarrage, avant l'aiguillage :
// l'interface ET la commande `cairn` en ont besoin. Empaqueté, il est déballé hors de l'asar (`asarUnpack`).
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { loadNative } from "../core/native.ts";

const RELATIVE = "native/build/Release/cairn_native.node";

/** Chemin du module : `<app>/native/…` en développement, `app.asar.unpacked/native/…` une fois empaqueté. */
export function nativeModulePath(appPath: string = app.getAppPath()): string {
  const unpacked = appPath.endsWith(".asar") ? `${appPath}.unpacked` : appPath;
  return path.join(unpacked, RELATIVE);
}

/** Charge le module ; renvoie `null` si tout va bien, sinon le message d'erreur (affiché clairement, sans planter). */
export function loadNativeModule(): string | null {
  const file = nativeModulePath();
  if (!existsSync(file)) return `Cairn native module not found: ${file}`;
  try {
    loadNative(file);
    return null;
  } catch (error) {
    return `Cairn native module failed to load (${file}): ${error instanceof Error ? error.message : String(error)}`;
  }
}
