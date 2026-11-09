// Suite racine des tests : chaque process de test a son propre CAIRN_HOME, jamais le vrai ~/.cairn.
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "bun:test";
import { loadNative, type NativeBinding, setNative } from "../src/core/native.ts";

process.env.CAIRN_HOME = mkdtempSync(path.join(os.tmpdir(), "cairn-test-"));
process.env.CAIRN_TOOLS_INVENTORY = "empty";

// Module natif (Trousseau, flock, NetFS) : chargé s'il est compilé (`bun scripts/build-native.ts`). Sinon, les tests
// qui en ont besoin sont sautés (`nativeLoaded`) et les autres tournent normalement.
export const nativeModulePath = path.resolve(import.meta.dir, "../native/build/Release/cairn_native.node");
export let nativeLoaded = false;
let realNative: NativeBinding | null = null;
if (existsSync(nativeModulePath)) {
  try {
    realNative = loadNative(nativeModulePath);
    nativeLoaded = true;
  } catch (error) {
    console.warn(`Cairn native module failed to load (${nativeModulePath}): ${String(error)}`);
  }
} else {
  console.warn("Cairn native module not built: run `bun scripts/build-native.ts` (native tests are skipped)");
}

// Tous les fichiers de test tournent dans le même process : un test qui simule le module natif (`setNative(fake)`
// ou `setNative(null)`) ne doit pas le retirer aux fichiers suivants. Le vrai module est remis après chaque test.
afterEach(() => setNative(realNative));
