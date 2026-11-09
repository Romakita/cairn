import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchedPath, launchedThroughLink } from "../../src/main/relaunch.ts";

// Régression (packaging) : lancée par ~/.local/bin/cairn, l'app ne trouvait pas les helpers de Chromium.
describe("relance par le vrai chemin quand l'app est lancée par un lien", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cairn-relaunch-"));
  const exec = path.join(dir, "Cairn.app/Contents/MacOS/Cairn");
  mkdirSync(path.dirname(exec), { recursive: true });
  writeFileSync(exec, "");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(exec, path.join(bin, "cairn"));

  test("un lien dans le PATH vers l'exécutable est détecté", () => {
    expect(launchedPath("cairn", `/nope:${bin}`)).toBe(path.join(bin, "cairn"));
    expect(launchedThroughLink("cairn", exec, `/nope:${bin}`)).toBe(true);
    expect(launchedThroughLink(path.join(bin, "cairn"), exec, "")).toBe(true);
  });

  test("le vrai chemin ou un autre programme ne déclenchent pas de relance", () => {
    expect(launchedThroughLink(exec, exec, "")).toBe(false);
    expect(launchedThroughLink("ls", exec, "/bin")).toBe(false);
    expect(launchedThroughLink("absent", exec, bin)).toBe(false);
  });
});
