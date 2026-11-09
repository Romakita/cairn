// Assistant de premier lancement (port d'OnboardingTests.swift).
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeConfig, defaultConfig, folder, newConfigDocument } from "../../src/core/config.ts";
import { ConfigStore } from "../../src/core/config-store.ts";
import { detectDraft, emptyDraft, homeChoices, makeConfig } from "../../src/core/onboarding.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { TOMLDocument } from "../../src/core/toml.ts";

const home = "/Users/test";
const existsIn = (set: Set<string>) => (p: string) => set.has(p);

describe("onboarding", () => {
  test("detects_folders_home_and_ai_tools", async () => {
    const existing = new Set([
      "/Volumes/workspaces",
      "/Users/test/Projets",
      "/Users/test/.zshrc",
      "/Users/test/.ssh",
      "/Users/test/.codex",
      "/Users/test/.claude.json",
    ]);
    const d = await detectDraft({
      home,
      legacyRootPath: "/Volumes/workspaces",
      exists: existsIn(existing),
      hiddenFolders: () => [],
    });
    expect(d.folders.map((f) => f.path)).toEqual(["/Volumes/workspaces", "/Users/test/Projets"]);
    expect(d.folders.map((f) => f.selected)).toEqual([true, false]);
    expect(d.home.map((h) => h.path)).toEqual([".ssh", ".zshrc"]);
    expect(d.ai.filter((a) => a.detected).map((a) => a.id)).toEqual(["claude-code", "codex"]);
  });

  test("home_lists_hidden_folders_sorted", async () => {
    const existing = new Set(["/Users/test/.zshrc", "/Users/test/.ssh", "/Users/test/.aws", "/Users/test/.config/gh"]);
    const hidden = [".ssh", ".aws", ".config", ".oh-my-zsh", ".Trash", ".cache", ".npm", ".claude", ".codex", ".cairn"];
    const d = await detectDraft({ home, exists: existsIn(existing), hiddenFolders: () => hidden });
    // Tri alphabétique sans tenir compte du point ; caches, corbeille, outils IA et Cairn écartés.
    expect(d.home.map((h) => h.path)).toEqual([".aws", ".config", ".config/gh", ".oh-my-zsh", ".ssh", ".zshrc"]);
    // Les fichiers connus restent cochés, les autres dossiers cachés sont à cocher.
    expect(d.home.filter((h) => h.selected).map((h) => h.path)).toEqual([".aws", ".config/gh", ".ssh", ".zshrc"]);
  });

  test("settings_list_every_home_item_sorted", async () => {
    const existing = new Set(["/Users/test/.zshrc", "/Users/test/.gitconfig"]);
    const items = await homeChoices([".config/mise", ".zshrc"], {
      home,
      exists: existsIn(existing),
      hiddenFolders: () => [".ssh", ".aws", ".cache", ".claude", ".Trash"],
      visibleFolders: () => ["Documents", "bin"],
    });
    // Éléments sauvegardés, fichiers connus, dossiers cachés et visibles : sans doublon, par ordre alphabétique.
    expect(items).toEqual([".aws", "bin", ".config/mise", "Documents", ".gitconfig", ".ssh", ".zshrc"]);
  });

  test("make_config_is_valid", async () => {
    const existing = new Set(["/tmp", "/Users/test/.codex", "/Users/test/.zshrc", "/Volumes/workspaces"]);
    const d = await detectDraft({ home, exists: existsIn(existing), hiddenFolders: () => [] });
    d.folders = [
      { path: "/tmp", selected: true },
      { path: "/nope", selected: false },
    ];
    d.destination = { kind: "smb", url: "smb://nas.local/backups", username: "romain" };
    d.background = true;
    const c = makeConfig(d);
    expect(c.folders.map((f) => f.path)).toEqual(["/tmp"]);
    // Pas de clé `keychain` : l'entrée du Trousseau se déduit de url + username.
    expect(c.destinations[0]?.keychain).toBeUndefined();
    expect(c.destinations[0]?.username).toBe("romain");
    expect(c.ai[0]?.categories).toEqual(["conversations", "config", "memories", "credentials"]);
    const { config: back, issues } = decodeConfig(TOMLDocument.parse(newConfigDocument(c).render()));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(back).toEqual(c);
  });

  test("credentials_only_with_encrypted_destination", () => {
    const d = emptyDraft();
    d.ai = [{ id: "codex", detected: true, categories: new Set(["conversations", "credentials"]) }];
    d.destination = { kind: "local", path: "/tmp" };
    d.encrypted = false;
    expect(makeConfig(d).ai[0]?.categories).toEqual(["conversations"]);
    d.encrypted = true;
    expect(makeConfig(d).ai[0]?.categories).toEqual(["conversations", "credentials"]);
    d.destination = { kind: "later" };
    expect(makeConfig(d).ai[0]?.categories).toEqual(["conversations"]);
  });

  test("abandon_writes_nothing_and_finish_writes_valid_file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-onboarding-"));
    const store = new ConfigStore(new CairnPaths(path.join(dir, ".cairn")));
    // L'assistant ne fait que lire (ici dans un home temporaire, jamais le vrai).
    await detectDraft({ home: dir });
    expect(await store.exists()).toBe(false); // l'assistant ne doit rien écrire avant la fin
    const d = emptyDraft();
    d.folders = [{ path: "/tmp", selected: true }];
    await store.save(makeConfig(d));
    const loaded = await store.load();
    expect(loaded.hasErrors).toBe(false);
    expect(loaded.config.folders.map((f) => f.path)).toEqual(["/tmp"]);
  });

  test("settings_change_keeps_hand_comment", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-onboarding-"));
    const paths = new CairnPaths(dir);
    const store = new ConfigStore(paths);
    await store.save(defaultConfig());
    const text = (await readFile(paths.config, "utf8")).replace("[schedule]", "# mon commentaire à moi\n[schedule]");
    await writeFile(paths.config, text);
    const c = (await store.load()).config;
    c.folders.push(folder("/tmp"));
    await store.save(c);
    expect(await readFile(paths.config, "utf8")).toContain("# mon commentaire à moi\n[schedule]");
    expect((await store.load()).config.folders.map((f) => f.path)).toEqual(["/tmp"]);
  });
});
