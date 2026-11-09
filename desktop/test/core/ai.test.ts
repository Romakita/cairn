// Port d'AITests.swift (profils, parties, vue) et des cas IA de RestoreWarningTests.swift (outils ouverts, plugins,
// identifiants, taille sauvegardée, dernière sauvegarde). La fusion de restauration (AIRestore) est portée ailleurs.
// Les snapshots SQLite sont dans sqlite-snapshot.test.ts. Tout se passe dans un home simulé (dossier temporaire).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AIProfile,
  aiJSON,
  aiManagedPaths,
  aiParts,
  BUNDLED_PROFILES,
  bytesOf,
  credentialsAllowed,
  credentialsBlock,
  credentialsBlockText,
  defaultMeasure,
  effectiveCategories,
  expandEntries,
  globMatch,
  isDatabase,
  isDetected,
  lastBackup,
  loadProfiles,
  openTools,
  openToolsLogLine,
  profileName,
  readProfileMeta,
  toolStats,
} from "../../src/core/ai/index.ts";
import { type CairnConfig, defaultConfig, destination } from "../../src/core/config.ts";
import { run } from "../../src/core/process.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Écrit un fichier de `size` octets (zéros). */
async function writeSized(file: string, size: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size));
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Base SQLite en WAL de `rows` lignes, créée avec /usr/bin/sqlite3 (une transaction par ligne, comme Swift). */
async function makeDB(file: string, rows: number): Promise<void> {
  const pad = "x".repeat(200);
  let sql = "PRAGMA journal_mode=WAL;\nCREATE TABLE IF NOT EXISTS t(x TEXT);\n";
  for (let i = 0; i < rows; i++) sql += `INSERT INTO t VALUES('row ${i} ${pad}');\n`;
  await run("/usr/bin/sqlite3", [file], { stdin: sql, stderr: "ignore" });
}

async function integrityOK(file: string): Promise<boolean> {
  const r = await run("/usr/bin/sqlite3", ["-readonly", file, "PRAGMA integrity_check;"], { stderr: "ignore" });
  return r.code === 0 && r.stdout.trim() === "ok";
}

/** Tous les chemins relatifs d'un dossier. */
async function files(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { recursive: true })).map(String);
  } catch {
    return [];
  }
}

/**
 * Copie d'une partie comme le moteur (parity/behavior.md §3.4) : `rsync -a --exclude-from -r --files-from src/ dst/`.
 * Le moteur n'est pas encore porté : ce test vérifie ce que rsync fait réellement des exclusions et de --files-from.
 */
async function copyPart(
  part: { source: string; excludes: string[]; filesFrom: string[] | null },
  dest: string,
  tmp: string,
): Promise<void> {
  await mkdir(tmp, { recursive: true });
  await mkdir(dest, { recursive: true });
  const ex = path.join(tmp, "exclude.txt");
  await writeFile(ex, part.excludes.map((e) => `${e}\n`).join(""));
  const args = ["-a", `--exclude-from=${ex}`];
  if (part.filesFrom) {
    const ff = path.join(tmp, "files.txt");
    await writeFile(ff, part.filesFrom.map((f) => `${f}\n`).join(""));
    args.push("-r", `--files-from=${ff}`);
  }
  const r = await run("/usr/bin/rsync", [...args, `${part.source}/`, `${dest}/`]);
  expect(r.code).toBe(0);
}

/** Faux home avec un Codex et un Claude Code minimaux. */
async function fakeHome(home: string): Promise<void> {
  await writeSized(path.join(home, ".codex/sessions/2026/11/08/rollout-a.jsonl.zst"), 5_000);
  await writeSized(path.join(home, ".codex/config.toml"), 100);
  await writeSized(path.join(home, ".codex/auth.json"), 100);
  await writeSized(path.join(home, ".codex/packages/standalone/bin/codex"), 50_000);
  await writeSized(path.join(home, ".codex/plugins/foo/x.js"), 10_000);
  await writeSized(path.join(home, ".codex/cache/c.bin"), 10_000);
  await makeDB(path.join(home, ".codex/state_5.sqlite"), 50);
  await makeDB(path.join(home, ".codex/logs_2.sqlite"), 10);
  await writeSized(path.join(home, ".claude/projects/-Volumes-workspaces-exports/s1.jsonl"), 3_000);
  await writeSized(path.join(home, ".claude/settings.json"), 100);
  await writeSized(path.join(home, ".claude/cache/x"), 100);
}

function configWith(ai: CairnConfig["ai"], destinations: CairnConfig["destinations"] = []): CairnConfig {
  const c = defaultConfig();
  c.ai = ai;
  c.destinations = destinations;
  return c;
}

const noneRunning: string[] = [];

describe("AI", () => {
  test("bundled_profiles_and_detection", async () => {
    expect(BUNDLED_PROFILES.map((p) => p.id)).toEqual(["claude-code", "claude-desktop", "codex"]);
    await withTempDir(async (home) => {
      for (const p of BUNDLED_PROFILES) expect(await isDetected(p, home)).toBe(false); // outil absent, sans erreur
      await fakeHome(home);
      const detected: string[] = [];
      for (const p of BUNDLED_PROFILES) if (await isDetected(p, home)) detected.push(p.id);
      expect(detected).toEqual(["claude-code", "codex"]);
    });
  });

  test("new_profile_without_code_change", async () => {
    await withTempDir(async (dir) => {
      await put(
        path.join(dir, "aider.json"),
        `{"id":"aider","version":1,"root":"~/.aider","detect":[".aider"],"credentials_in_keychain":false,
          "categories":{"conversations":["history/"],"config":["conf.yml"],"memories":[],"credentials":[]},
          "sqlite":[],"exclude":[],"reinstall":[]}`,
      );
      await put(path.join(dir, "broken.json"), '{"id":"x"}');
      await put(path.join(dir, "notes.txt"), "{}");
      const p = await loadProfiles(dir);
      expect(p.map((x) => x.id)).toEqual(["aider"]);
      expect(p[0]?.categories.config).toEqual(["conf.yml"]);
    });
  });

  test("reinstalled_and_cache_never_in_copied_categories", () => {
    for (const p of BUNDLED_PROFILES) {
      const copied = Object.values(p.categories).flat();
      for (const forbidden of ["plugins/", "packages/", "cache/", "logs_"]) {
        const bad = copied.some(
          (e) => e.startsWith(forbidden) || (e.includes(`/${forbidden}`) && !e.endsWith(".json")),
        );
        expect(bad).toBe(false);
      }
    }
  });

  test("profile_added_in_folder_is_listed_and_excluded_from_home", async () => {
    await withTempDir(async (dir) => {
      const profiles = path.join(dir, "profiles");
      await put(
        path.join(profiles, "aider.json"),
        `{"id":"aider","name":"Aider","version":1,"root":"~/.aider","detect":[".aider", ".aider.conf.yml"],
          "credentials_in_keychain":false,
          "categories":{"conversations":["history/"],"config":["conf.yml"],"memories":[],"credentials":[]},
          "sqlite":[],"exclude":[],"reinstall":[]}`,
      );
      const all = [...BUNDLED_PROFILES, ...(await loadProfiles(profiles))];
      expect(aiManagedPaths(all)).toContain(".aider");
      expect(aiManagedPaths(all)).toContain(".aider.conf.yml");
      expect(profileName("aider", all)).toBe("Aider");
      // Les dossiers gérés par défaut restent ceux des profils fournis.
      for (const p of [".claude", ".claude.json", ".codex", "Library/Application Support/Claude"]) {
        expect(aiManagedPaths()).toContain(p);
      }
      expect(profileName("claude-code")).toBe("Claude Code");
      // Sans nom dans le profil : repli sur la clé de traduction.
      expect(profileName("unknown-tool")).toBe("ai.unknown-tool");
    });
  });

  test("category_entries_dirs_files_and_globs", async () => {
    await withTempDir(async (root) => {
      await writeSized(path.join(root, "sessions/a.jsonl"), 1);
      await writeSized(path.join(root, "thread_history_1.sqlite"), 1);
      await writeSized(path.join(root, "thread_history_2.sqlite"), 1);
      await writeSized(path.join(root, "rules/x.md"), 1);
      await writeSized(path.join(root, "a/b.json"), 1);
      const out = await expandEntries(
        ["sessions/", "missing/", "config.toml", "thread_history_*.sqlite", "a/*.json", "rules/"],
        root,
      );
      expect(out).toEqual(["sessions", "thread_history_1.sqlite", "thread_history_2.sqlite", "a/b.json", "rules"]);
      const codex = BUNDLED_PROFILES.find((p) => p.id === "codex") as AIProfile;
      expect(isDatabase("state_5.sqlite", codex)).toBe(true);
      expect(isDatabase("sessions", codex)).toBe(false);
      const claude = BUNDLED_PROFILES.find((p) => p.id === "claude-code") as AIProfile;
      expect(isDatabase(".claude/x.db", claude)).toBe(true);
      expect(isDatabase(".claude/settings.json", claude)).toBe(false);
    });
  });

  test("glob_matches_like_fnmatch", () => {
    expect(globMatch("*.sqlite", "state_5.sqlite")).toBe(true);
    expect(globMatch("rollout-*", "rollout-a.jsonl.zst")).toBe(true);
    expect(globMatch("ccd-*.json", "ccd-x.jsonl")).toBe(false);
    expect(globMatch(".claude/*.db", ".claude/a/b.db")).toBe(true); // `*` traverse `/` (sans FNM_PATHNAME)
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("[a-c]x", "bx")).toBe(true);
    expect(globMatch("[!a-c]x", "bx")).toBe(false);
    expect(globMatch("..codex-global-state.json.*", "..codex-global-state.json.tmp")).toBe(true);
  });

  test("backup_parts_by_category_without_packages", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      await fakeHome(home);
      const c = configWith([{ id: "codex", categories: ["conversations", "config"] }]);
      const staging = path.join(dir, "staging");
      const parts = await aiParts(c, staging, { home, running: noneRunning });
      expect(new Set(parts.map((p) => p.target))).toEqual(
        new Set(["ai/codex/conversations", "ai/codex/config", "ai/codex/meta"]),
      );
      const v = path.join(dir, "dest/ai/codex");
      for (const p of parts) await copyPart(p, path.join(dir, "dest", p.target), path.join(dir, "tmp", p.target));
      expect(existsSync(path.join(v, "conversations/sessions/2026/11/08/rollout-a.jsonl.zst"))).toBe(true);
      expect(existsSync(path.join(v, "config/config.toml"))).toBe(true);
      expect(existsSync(path.join(v, "credentials"))).toBe(false); // identifiants non cochés
      expect(await integrityOK(path.join(v, "meta/sqlite/conversations/state_5.sqlite"))).toBe(true);
      const all = await files(v);
      for (const bad of ["packages", "plugins", "cache", "logs_2.sqlite", "-wal", "-shm"]) {
        expect(all.filter((f) => f.includes(bad))).toEqual([]);
      }
      const meta = await readProfileMeta(path.join(v, "meta/profile.json"));
      expect(meta?.reinstall["plugins/"]).toEqual(["foo"]);
    });
  });

  test("profile_json_exact_format", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      await writeSized(path.join(home, ".codex/config.toml"), 10);
      await writeSized(path.join(home, ".codex/packages/standalone/x"), 10);
      const staging = path.join(dir, "staging");
      await aiParts(configWith([{ id: "codex", categories: ["config"] }]), staging, {
        home,
        running: ["codex"],
      });
      const text = await readFile(path.join(staging, "ai-codex/profile.json"), "utf8");
      const h = home.replace(/\//g, "\\/");
      expect(text).toBe(
        `{\n  "categories" : [\n    "config"\n  ],\n  "home" : "${h}",\n  "profile" : "codex",\n` +
          `  "profile_version" : 1,\n  "reinstall" : {\n    "packages\\/" : [\n      "standalone"\n    ],\n` +
          `    "plugins\\/" : [\n\n    ]\n  },\n  "root" : "${h}\\/.codex",\n  "running" : [\n    "codex"\n  ]\n}`,
      );
    });
  });

  test("open_tools_are_reported_for_the_backup_log", async () => {
    await withTempDir(async (home) => {
      await writeSized(path.join(home, ".codex/config.toml"), 10);
      await writeSized(path.join(home, ".claude/settings.json"), 10);
      const c = configWith([
        { id: "codex", categories: ["config"] },
        { id: "claude-code", categories: ["config"] },
      ]);
      expect(await openTools(c, { home, running: ["codex", "Finder"] })).toEqual(["codex"]);
      const line = await openToolsLogLine(c, { home, running: ["claude", "Codex"] });
      expect(line).toBe("ai: open during backup (SQLite copied by snapshot): claude-code, codex");
      expect(await openToolsLogLine(c, { home, running: [] })).toBeNull();
    });
  });

  test("declared_plugins_are_listed_in_profile_json", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      await put(
        path.join(home, ".claude/plugins/installed_plugins.json"),
        '{"version":2,"plugins":{"github@official":[{"scope":"user","version":"abc"}],"tsed@tsed":[{"scope":"user","version":"1"}]}}',
      );
      await put(
        path.join(home, ".claude/plugins/known_marketplaces.json"),
        `{"official":{"source":{"source":"github","repo":"anthropics/claude-plugins-official"}},
          "tsed":{"source":{"source":"git","url":"https://github.com/tsedio/tsed.git"}}}`,
      );
      await writeSized(path.join(home, ".claude/plugins/cache/official/github/abc/x.js"), 10);
      await put(
        path.join(home, ".codex/config.toml"),
        'model = "x"\n[plugins."github@openai-curated"]\nenabled = true\n[plugins."tsed@tsed"]\nenabled = false\n' +
          '[marketplaces.tsed]\nsource_type = "git"\nsource = "https://github.com/tsedio/tsed.git"\n',
      );
      const c = configWith([
        { id: "claude-code", categories: ["config"] },
        { id: "codex", categories: ["config"] },
      ]);
      const staging = path.join(dir, "staging");
      await aiParts(c, staging, { home, running: noneRunning });
      const claude = await readProfileMeta(path.join(staging, "ai-claude-code/profile.json"));
      expect(claude?.plugins?.plugins).toEqual([
        { name: "github@official", version: "abc", scope: "user" },
        { name: "tsed@tsed", version: "1", scope: "user" },
      ]);
      expect(claude?.plugins?.marketplaces).toEqual([
        { name: "official", source: "anthropics/claude-plugins-official" },
        { name: "tsed", source: "https://github.com/tsedio/tsed.git" },
      ]);
      // Repli : noms de dossiers.
      expect(claude?.reinstall[".claude/plugins/"]).toEqual([
        "cache",
        "installed_plugins.json",
        "known_marketplaces.json",
      ]);
      const codex = await readProfileMeta(path.join(staging, "ai-codex/profile.json"));
      expect(codex?.plugins?.plugins.map((p) => p.name)).toEqual(["github@openai-curated", "tsed@tsed"]);
      expect(codex?.plugins?.marketplaces).toEqual([{ name: "tsed", source: "https://github.com/tsedio/tsed.git" }]);
      expect(codex?.plugins?.plugins.at(-1)?.enabled).toBe(false);
    });
  });

  // Spec ai-tools (modifiée), scénario « Destination non chiffrée ».
  test("credentials_only_when_every_destination_is_encrypted", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      await writeSized(path.join(home, ".codex/config.toml"), 10);
      await writeSized(path.join(home, ".codex/auth.json"), 10);
      const c = configWith([{ id: "codex", categories: ["config", "credentials"] }]);
      expect(credentialsAllowed(c)).toBe(false); // aucune destination
      expect(credentialsBlock(c)).toBe("no_destination");
      c.destinations = [
        destination("a", "local", { path: path.join(dir, "a"), encrypted: true }),
        destination("b", "local", { path: path.join(dir, "b"), encrypted: false }),
      ];
      expect(credentialsAllowed(c)).toBe(false);
      expect(credentialsBlock(c)).toBe("unencrypted_destination");
      expect(credentialsBlockText(c)).toBe("Credentials are checked but ignored: every destination must be encrypted.");
      expect(effectiveCategories(c.ai[0] as CairnConfig["ai"][number], c)).toEqual(["config"]);
      let parts = await aiParts(c, path.join(dir, "s1"), { home, running: noneRunning });
      expect(parts.map((p) => p.target)).not.toContain("ai/codex/credentials");
      // Aucun fichier d'identifiants copié, même par une autre partie.
      expect(parts.flatMap((p) => p.filesFrom ?? []).filter((f) => f.includes("auth.json"))).toEqual([]);
      const meta = await readProfileMeta(path.join(dir, "s1/ai-codex/profile.json"));
      expect(meta?.categories).toEqual(["config"]);
      (c.destinations[1] as CairnConfig["destinations"][number]).encrypted = true;
      expect(credentialsAllowed(c)).toBe(true);
      expect(credentialsBlockText(c)).toBeNull();
      parts = await aiParts(c, path.join(dir, "s2"), { home, running: noneRunning });
      expect(parts.map((p) => p.target)).toContain("ai/codex/credentials");
    });
  });

  // Spec ai-tools, scénario « Jeton dans le Trousseau ».
  test("keychain_token_is_flagged_for_the_view", async () => {
    await withTempDir(async (home) => {
      const claude = BUNDLED_PROFILES.find((p) => p.id === "claude-code") as AIProfile;
      const codex = BUNDLED_PROFILES.find((p) => p.id === "codex") as AIProfile;
      expect(claude.credentials_in_keychain).toBe(true);
      expect(codex.credentials_in_keychain).toBe(false);
      const json = JSON.parse(aiJSON([await toolStats(claude, home, async () => ({ size: 0 }))], defaultConfig()));
      expect(json.tools[0].credentials_in_keychain).toBe(true);
    });
  });

  test("saved_size_and_last_backup_date", async () => {
    await withTempDir(async (dir) => {
      const codex = BUNDLED_PROFILES.find((p) => p.id === "codex") as AIProfile;
      const stats = await toolStats(codex, dir);
      stats.bytesByCategory = { config: 10, conversations: 100, credentials: 1 };
      expect(bytesOf(stats, ["config", "conversations"])).toBe(110);
      const destPath = path.join(dir, "dest");
      const c = configWith(
        [{ id: "codex", categories: ["config"] }],
        [destination("d", "local", { path: destPath, encrypted: false })],
      );
      // Version écrite comme par le moteur : `cairn/<machine>/versions/<nom>/manifest.json`.
      const version = "2026-09-21T143320";
      await put(
        path.join(destPath, "cairn/m/versions", version, "manifest.json"),
        JSON.stringify({ parts: [{ target: "ai/codex/config", kind: "ai" }] }),
      );
      await put(
        path.join(destPath, "cairn/m/versions/2026-09-22T100000/manifest.json"),
        JSON.stringify({ parts: [{ target: "home", kind: "home" }] }),
      );
      const expected = new Date(2026, 8, 21, 14, 33, 20);
      expect(await lastBackup("codex", c, { destinations: {} }, "m")).toEqual(expected);
      // Pas de version lisible : dernière réussite enregistrée, si l'outil est configuré.
      const when = new Date(1_790_000_000_000);
      const state = { destinations: { d: { lastSuccess: when } } };
      expect(await lastBackup("claude-code", c, state, "m")).toBeNull(); // non configuré
      c.ai.push({ id: "claude-code", categories: ["config"] });
      expect(await lastBackup("claude-code", c, state, "m")).toEqual(when);
      // Destination chiffrée : rien n'est monté pour lire ses versions.
      c.destinations = [destination("d", "local", { path: destPath, encrypted: true })];
      expect(await lastBackup("codex", c, state, "m")).toEqual(when);
    });
  });

  test("stats_sizes_conversations_and_json", async () => {
    await withTempDir(async (home) => {
      await fakeHome(home);
      const when = new Date("2026-11-08T10:00:00Z");
      await utimes(path.join(home, ".codex/sessions/2026/11/08/rollout-a.jsonl.zst"), when, when);
      const codex = BUNDLED_PROFILES.find((p) => p.id === "codex") as AIProfile;
      const s = await toolStats(codex, home);
      expect(s.detected).toBe(true);
      expect(s.conversations).toBe(1);
      expect(s.latestConversation?.toISOString()).toBe(when.toISOString());
      // Tailles de `Scanner.measure` (taille occupée sur le disque).
      const size = async (rel: string) => (await defaultMeasure(path.join(home, rel))).size;
      expect(s.bytesByCategory.credentials).toBe(await size(".codex/auth.json"));
      expect(s.bytesByCategory.config).toBe(await size(".codex/config.toml"));
      expect(s.bytesByCategory.conversations).toBe(
        (await size(".codex/sessions")) + (await size(".codex/state_5.sqlite")),
      );
      expect(s.bytesByCategory.memories).toBe(0);
      expect(s.notCopiedBytes).toBe((await size(".codex/plugins")) + (await size(".codex/packages")));
      expect(s.notCopiedBytes).toBeGreaterThanOrEqual(60_000);
      expect(s.totalBytes).toBe(await size(".codex"));
      const c = configWith([{ id: "codex", categories: ["config"] }]);
      const json = JSON.parse(aiJSON([s], c));
      expect(Object.keys(json.tools[0]).sort()).toEqual([
        "bytes_by_category",
        "conversations",
        "credentials_in_keychain",
        "detected",
        "id",
        "latest_conversation",
        "not_copied_bytes",
        "selected_categories",
        "total_bytes",
      ]);
      expect(json.tools[0].latest_conversation).toBe("2026-11-08T10:00:00Z");
      expect(json.tools[0].selected_categories).toEqual(["config"]);
      // Racine « ~ » (Claude Code) : la taille totale est celle des chemins de détection.
      const claude = BUNDLED_PROFILES.find((p) => p.id === "claude-code") as AIProfile;
      const cs = await toolStats(claude, home);
      expect(cs.totalBytes).toBe((await size(".claude")) + (await size(".claude.json")));
      expect(cs.totalBytes).toBeGreaterThanOrEqual(3_200);
      expect(cs.conversations).toBe(1);
    });
  });
});
