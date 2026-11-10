// Classement « régénérable » et exclusions de la sauvegarde (Scanner.alwaysRegenerable/conditional, BackupExclusions).
// Cas portés de BackupTests (exclusions_follow_gitignore_and_markers, home_selection_excludes_ai_dirs_and_caches :
// partie sélection) et RestoreWarningTests (aiManaged), plus les tables exactes de parity/behavior.md §3.1.
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ALWAYS_REGENERABLE,
  APPLICATION_PATTERNS,
  aiManaged,
  CATEGORIES,
  CLASSIFICATION_RULES,
  CONDITIONAL_REGENERABLE,
  classify,
  classifyWith,
  detectGenerated,
  excludesForFolder,
  HOME_EXCLUDES,
  homeItems,
  isRegenerable,
  NESTED_REGENERABLE,
  REGENERABLE_CATEGORIES,
  staticPatterns,
} from "../../src/core/regenerable.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function put(file: string, size = 10): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size));
}

describe("regenerable", () => {
  test("categories_and_regenerable_set", () => {
    expect([...CATEGORIES]).toEqual(["source", "git", "deps", "build", "ios", "python", "cache", "trash"]);
    expect([...REGENERABLE_CATEGORIES]).toEqual(["deps", "build", "ios", "python", "cache"]);
    expect(isRegenerable("git")).toBe(false);
    expect(isRegenerable("trash")).toBe(false);
  });

  test("tables_match_parity_3_1", () => {
    const byCategory = (c: string) =>
      Object.keys(ALWAYS_REGENERABLE)
        .filter((k) => ALWAYS_REGENERABLE[k] === c)
        .sort();
    expect(byCategory("git")).toEqual([".git"]);
    expect(byCategory("deps")).toEqual(["bower_components", "jspm_packages", "node_modules"]);
    expect(byCategory("ios")).toEqual(["Carthage", "DerivedData", "Pods"]);
    expect(byCategory("build")).toEqual(
      [
        "dist",
        "coverage",
        ".next",
        ".nuxt",
        ".angular",
        ".turbo",
        ".nx",
        ".vite",
        ".parcel-cache",
        ".svelte-kit",
        ".output",
        "storybook-static",
        ".docusaurus",
        ".expo",
      ].sort(),
    );
    expect(byCategory("python")).toEqual(
      [".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox"].sort(),
    );
    expect(byCategory("cache")).toEqual([".cache", ".eslintcache", ".npm-cache", ".pnpm-store", ".sass-cache"].sort());
    expect(NESTED_REGENERABLE).toEqual({ ".npm/_cacache": "cache", ".bun/install/cache": "cache" });
    expect(byCategory("trash")).toEqual([".Trash", ".Trashes"]);
    expect(CONDITIONAL_REGENERABLE).toEqual({
      build: [
        "build",
        ["package.json", "build.gradle", "build.gradle.kts", "settings.gradle", "CMakeLists.txt", "pubspec.yaml"],
      ],
      out: ["build", ["package.json", "tsconfig.json"]],
      target: ["build", ["Cargo.toml", "pom.xml"]],
      ".gradle": ["build", ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"]],
      vendor: ["deps", ["composer.json", "Gemfile", "go.mod"]],
      ".build": ["build", ["Package.swift"]],
    });
  });

  test("classify_conditional_needs_marker_in_parent", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "node/package.json"));
      await put(path.join(dir, "rust/Cargo.toml"));
      expect(await classify("node_modules", dir)).toBe("deps");
      expect(await classify("build", path.join(dir, "node"))).toBe("build");
      expect(await classify("build", path.join(dir, "rust"))).toBe("source");
      expect(await classify("target", path.join(dir, "rust"))).toBe("build");
      expect(await classify("vendor", path.join(dir, "node"))).toBe("source");
      expect(await classify("constructor", dir)).toBe("source"); // pas de piège de prototype
      expect(await classify("src", dir)).toBe("source");
      // La variante synchrone des workers donne les mêmes réponses.
      const exists = (f: string) => existsSync(f);
      for (const [name, parent] of [
        ["build", path.join(dir, "node")],
        ["build", path.join(dir, "rust")],
        ["target", path.join(dir, "rust")],
        [".git", dir],
        ["toString", dir],
      ] as const) {
        expect(classifyWith(CLASSIFICATION_RULES, exists, name, parent)).toBe(await classify(name, parent));
      }
    });
  });

  test("package_caches_are_regenerable_and_apps_are_not", async () => {
    await withTempDir(async (dir) => {
      const exists = (f: string) => existsSync(f);
      const cases: Array<[string, string, string]> = [
        [".npm-cache", path.join(dir, "proj"), "cache"],
        [".pnpm-store", dir, "cache"],
        ["_cacache", path.join(dir, ".npm"), "cache"],
        ["cache", path.join(dir, ".bun/install"), "cache"],
        ["_cacache", path.join(dir, "other"), "source"], // nom seul trop générique
        ["cache", path.join(dir, "install"), "source"],
        ["cache", path.join(dir, "x/install"), "source"],
        ["install", path.join(dir, ".bun"), "source"],
        ["bin", path.join(dir, ".bun"), "source"],
        ["WebStorm.app", path.join(dir, "Applications"), "source"], // jamais proposé au nettoyage
        ["Applications", dir, "source"],
        ["Demo.app", path.join(dir, "proj/build"), "source"],
      ];
      for (const [name, parent, category] of cases) {
        expect(await classify(name, parent)).toBe(category as never);
        expect(classifyWith(CLASSIFICATION_RULES, exists, name, parent)).toBe(category as never);
      }
    });
  });

  test("static_patterns_order", () => {
    const list = staticPatterns();
    expect(list.slice(0, 5)).toEqual([
      "/.Spotlight-V100/",
      "/.fseventsd/",
      "/.Trashes/",
      "/.TemporaryItems/",
      "/.DocumentRevisions-V100/",
    ]);
    expect(list.slice(-10)).toEqual([
      ".npm/_cacache/",
      ".bun/install/cache/",
      ".nyc_output/",
      ".stylelintcache",
      ".eslintcache",
      "*.tsbuildinfo",
      ".terraform/",
      ".DS_Store",
      "/Applications/",
      "*.app/",
    ]);
    expect(list.slice(-2)).toEqual([...APPLICATION_PATTERNS]);
    const regenerable = list.slice(5, -10);
    expect(regenerable).toEqual([...regenerable].sort());
    expect(regenerable).toContain("node_modules/");
    expect(regenerable).toContain(".venv/");
    expect(regenerable).not.toContain(".git/");
    expect(regenerable).not.toContain(".Trash/");
    expect(regenerable.length).toBe(Object.values(ALWAYS_REGENERABLE).filter(isRegenerable).length);
  });

  test("exclusions_follow_gitignore_and_markers", async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, "repo");
      await put(path.join(repo, "lib/versioned.js"));
      await put(path.join(repo, "build/out.js"));
      await writeFile(path.join(repo, ".gitignore"), "build/\n");
      await promisify(execFile)("/usr/bin/git", ["-C", repo, "init", "-q"]);
      await put(path.join(dir, "plain/lib/x.js")); // pas de package.json : gardé
      await put(path.join(dir, "node/package.json"));
      await put(path.join(dir, "node/out/y.js"));
      const list = await excludesForFolder(dir, ["*.iso"], [`${dir}/backups`]);
      expect(list).toContain("/repo/build/");
      expect(list).not.toContain("/repo/lib/"); // lib versionné : copié
      expect(list).not.toContain("/plain/lib/");
      expect(list).toContain("/node/out/");
      expect(list).toContain("node_modules/");
      expect(list).toContain("*.iso");
      expect(list).toContain("/backups/");
      expect(list).not.toContain(".git/"); // l'historique git est sauvegardé
    });
  });

  test("detect_generated_skips_links_regenerable_and_detected", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "a/tmp/inner/tmp/x"));
      await put(path.join(dir, "node_modules/pkg/tmp/x"));
      await put(path.join(dir, "real/tmp/x"));
      await symlink(path.join(dir, "real"), path.join(dir, "link"));
      const visited: string[] = [];
      const found = await detectGenerated(dir, { visiting: (rel) => visited.push(rel) });
      expect(found).toEqual(["/a/tmp/", "/real/tmp/"]); // tri, dossier détecté non parcouru, ni lien ni node_modules
      expect(visited).toEqual(["", "a", "real"]);
      const controller = new AbortController();
      controller.abort();
      expect(await detectGenerated(dir, { signal: controller.signal })).toEqual([]);
    });
  });

  test("home_selection_excludes_ai_dirs", async () => {
    await withTempDir(async (home) => {
      for (const f of [".zshrc", ".claude/settings.json", ".codex/config.toml", ".config/gcloud/creds.json"]) {
        await put(path.join(home, f), 100);
      }
      const profiles = [{ homePaths: [".claude", ".claude.json"] }, { homePaths: [".codex"] }];
      const items = await homeItems([".zshrc", ".claude", ".codex", ".config/gcloud", ".absent"], home, profiles);
      expect(items).toEqual([".zshrc", ".config/gcloud"]);
      expect(HOME_EXCLUDES).toContain("logs/");
      expect(HOME_EXCLUDES).toContain("cache/");
    });
  });

  test("ai_managed_from_profiles", async () => {
    await withTempDir(async (home) => {
      await put(path.join(home, ".aider/history/h.md"));
      await put(path.join(home, ".zshrc"));
      const all = [{ homePaths: [".claude", ".claude.json"] }, { homePaths: [".aider", ".aider.conf.yml", ".aider"] }];
      expect(aiManaged(all)).toEqual([".claude", ".claude.json", ".aider", ".aider.conf.yml"]);
      expect(await homeItems([".aider", "~/.aider.conf.yml", ".zshrc"], home, all)).toEqual([".zshrc"]);
    });
  });
});
