// Régressions de parity/behavior.md §1.7 et §2 qui touchent l'inventaire des outils : un test par commit (ou par
// fichier de tests Swift). Jamais de brew, mise… réels : exécuteur factice et home simulé.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CommandRunner,
  classify,
  cliTool,
  installed,
  inventoryJSON,
  readToolLists,
} from "../../src/core/inventory/index.ts";
import { setLanguage } from "../../src/core/l10n.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function recordingRunner(outputs: Record<string, string>): CommandRunner & { commands: string[] } {
  const commands: string[] = [];
  const runner = async (command: readonly string[]) => {
    const key = command.join(" ");
    commands.push(key);
    for (const [k, v] of Object.entries(outputs)) if (key.startsWith(k)) return { status: 0, output: v };
    return { status: 127, output: "" };
  };
  return Object.assign(runner, { commands });
}

describe("régressions : inventaire des outils", () => {
  test("0.8.0 (🆕): seules les formules installées à la demande, jamais de cask ni de mas", async () => {
    await withTempDir(async (home) => {
      const runner = recordingRunner({
        "brew leaves --installed-on-request": "gh\n",
        "brew list --versions gh": "gh 2.93.0\n",
        "brew tap": "",
      });
      const { tools } = await installed(home, runner);
      expect(tools.map((t) => t.name)).toEqual(["gh"]);
      expect(runner.commands.filter((c) => c.startsWith("brew"))).toEqual([
        "brew leaves --installed-on-request",
        "brew list --versions gh",
        "brew tap",
      ]);
      expect(runner.commands.some((c) => c.includes("--cask") || c.startsWith("mas "))).toBe(false);
    });
  });

  test("ConfigWarningTests: un exécutable de ~/.local/bin n'est jamais lancé (pas de --version)", async () => {
    await withTempDir(async (home) => {
      const bin = path.join(home, ".local/bin");
      await mkdir(bin, { recursive: true });
      const marker = path.join(home, "ran");
      await writeFile(path.join(bin, "trap"), `#!/bin/sh\ntouch "${marker}"\n`);
      await chmod(path.join(bin, "trap"), 0o755);
      const runner = recordingRunner({});
      const { tools } = await installed(home, runner);
      expect(tools.find((t) => t.name === "trap")?.version).toBeNull();
      expect(runner.commands.some((c) => c.includes("trap"))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    });
  });

  test("ConfigWarningTests: le JSON de `cairn tools --json` est identique en anglais et en français", () => {
    const inv = classify({
      tools: [cliTool("ripgrep", "brew", "15", ["rg"])],
      taps: [],
      homeMarkers: new Set(),
      projectMarkers: new Set(),
      history: new Map([["rg", 4]]),
      excluded: new Set(),
    });
    setLanguage("fr-FR");
    const fr = inventoryJSON(inv);
    setLanguage("en-US");
    expect(inventoryJSON(inv)).toBe(fr);
  });

  test("46a9475: un nom d'outil hérité n'est jamais interprété (lu tel quel, commande tirée des règles)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "Brewfile"), 'brew "$(touch pwned)"\nbrew "ripgrep"\n');
      const { tools } = await readToolLists(dir);
      expect(tools.map((t) => t.name)).toEqual(["$(touch pwned)", "ripgrep"]);
      expect(tools[1]?.commands).toEqual(["rg"]);
    });
  });
});
