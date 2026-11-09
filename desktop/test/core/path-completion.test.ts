// Complétion des chemins du home (port de PathCompletionTests.swift).
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localizedStandardCompare, pathSuggestions } from "../../src/core/path-completion.ts";

async function tempHome(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "cairn-home-")));
}

async function touch(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "x");
}

const paths = async (input: string, base: string, excluding?: Set<string>) =>
  (await pathSuggestions(input, base, { excluding })).map((s) => s.path);

describe("path-completion", () => {
  test("suggests_hidden_entries_when_prefix_starts_with_dot", async () => {
    const home = await tempHome();
    await touch(path.join(home, ".zshrc"));
    await touch(path.join(home, ".config/starship.toml"));
    await touch(path.join(home, "Documents/a.txt"));
    expect(await paths(".", home)).toEqual([".config/", ".zshrc"]); // dossiers d'abord
    expect(await paths("", home)).toEqual(["Documents/"]);
  });

  test("completes_inside_subfolders_and_ignores_case", async () => {
    const home = await tempHome();
    await touch(path.join(home, ".config/Starship.toml"));
    await touch(path.join(home, ".config/gh/hosts.yml"));
    expect(await paths("~/.config/st", home)).toEqual([".config/Starship.toml"]);
    expect(await paths(".config/", home)).toEqual([".config/gh/", ".config/Starship.toml"]);
  });

  test("excludes_existing_items_and_refuses_escaping_paths", async () => {
    const home = await tempHome();
    await touch(path.join(home, ".zshrc"));
    await touch(path.join(home, ".zprofile"));
    expect(await paths(".z", home, new Set([".zshrc"]))).toEqual([".zprofile"]);
    expect(await paths("../", home)).toEqual([]);
    expect(await paths("/etc/", home)).toEqual([]);
    expect(await paths("nope/", home)).toEqual([]);
  });

  test("Finder ordering: case-insensitive, numbers by value", () => {
    expect(["dossier10", "Dossier2", "dossier1"].sort(localizedStandardCompare)).toEqual([
      "dossier1",
      "Dossier2",
      "dossier10",
    ]);
  });
});
