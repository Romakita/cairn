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

/** Binaire de test Swift (CairnCore 0.8.0) : `swift build --package-path Cairn --product CairnTestHelper`. */
export function swiftTestHelper(): string | null {
  const root = path.resolve(import.meta.dir, "../../../Cairn/.build");
  for (const candidate of ["debug/CairnTestHelper", "release/CairnTestHelper", "out/Products/Debug/CairnTestHelper"]) {
    const file = path.join(root, candidate);
    if (existsSync(file)) return file;
  }
  return null;
}
