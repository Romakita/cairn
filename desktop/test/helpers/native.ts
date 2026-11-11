// Module natif pour les tests : chemin du binaire compilé et présence (chargé par test/setup.ts).
import { existsSync } from "node:fs";
import path from "node:path";
import { native } from "../../src/core/native.ts";

export const NATIVE_MODULE = path.resolve(import.meta.dir, "../../native/build/Release/cairn_native.node");

/** Le module natif est chargé (sinon les tests qui en dépendent sont sautés). */
export function nativeAvailable(): boolean {
  try {
    native();
    return true;
  } catch {
    return false;
  }
}

/**
 * Binaire de test Swift de la 0.8.0 (`CairnTestHelper`), pour les tests d'interopérabilité (verrou, journal) :
 * chemin dans `CAIRN_SWIFT_HELPER`, construit depuis le tag `v0.8.0` (`git worktree add /tmp/cairn-080 v0.8.0`, puis
 * `swift build --package-path /tmp/cairn-080/Cairn --product CairnTestHelper`). Sans lui, ces tests sont sautés.
 */
export function swiftTestHelper(): string | null {
  const file = process.env.CAIRN_SWIFT_HELPER;
  return file && existsSync(file) ? file : null;
}
