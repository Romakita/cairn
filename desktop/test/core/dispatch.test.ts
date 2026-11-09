import { describe, expect, test } from "bun:test";
import { isCommandLine } from "../../src/cli/dispatch.ts";

describe("aiguillage entre la ligne de commande et l'interface", () => {
  test("une commande ou une option globale lance la ligne de commande", () => {
    for (const args of [["backup"], ["--version"], ["-h"], ["--lang", "fr-FR", "analyze"], ["--config", "x.toml"]]) {
      expect(isCommandLine(args)).toBe(true);
    }
  });

  test("les arguments ajoutés par macOS sont ignorés", () => {
    expect(isCommandLine(["-psn_0_12345", "git"])).toBe(true);
    expect(isCommandLine(["-NSDocumentRevisionsDebugMode", "YES"])).toBe(false);
  });

  test("sans commande, c'est l'interface", () => {
    expect(isCommandLine([])).toBe(false);
    expect(isCommandLine(["--gallery"])).toBe(false);
    expect(isCommandLine(["git-worker"])).toBe(false);
  });
});
