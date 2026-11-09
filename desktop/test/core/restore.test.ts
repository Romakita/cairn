// Port de RestoreTests.swift (mêmes cas, mêmes attentes), plus les scénarios de la spec `restore` modifiée
// (réinstallation : Homebrew absent, échec d'un outil, outil go). Home simulé et destinations temporaires ; les
// commandes d'installation passent par un exécuteur factice : rien n'est installé, Terminal n'est jamais ouvert.
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { writeFile as writeText } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { aiParts } from "../../src/core/ai/backup.ts";
import { defaultBackupDependencies } from "../../src/core/backup/defaults.ts";
import { BackupEngine } from "../../src/core/backup/engine.ts";
import { BackupService } from "../../src/core/backup/run.ts";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { backupPart } from "../../src/core/backup/types.ts";
import { listVersions, versionsDir } from "../../src/core/backup/versions.ts";
import { defaultConfig, destination, folder, RECOMMENDED_RETENTION } from "../../src/core/config.ts";
import { ConfigStore } from "../../src/core/config-store.ts";
import { systemRunner } from "../../src/core/inventory/collector.ts";
import { readToolLists } from "../../src/core/inventory/tool-lists.ts";
import { t } from "../../src/core/l10n.ts";
import { machineName } from "../../src/core/machine.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import {
  archMatches,
  checkTools,
  defaultPlan,
  defaultVersion,
  HOMEBREW_INSTALL,
  installCommand,
  notRewritten,
  openRestoreSource,
  RestoreService,
  type RestoreSource,
  type RestoreVersion,
  versionNamed,
  versionsOnDestination,
} from "../../src/core/restore/index.ts";
import { keepVersions } from "../../src/core/retention.ts";
import { withTempDir, writeFile } from "../helpers/backup-env.ts";
import { nativeAvailable } from "../helpers/native.ts";
import { legacyBackup, put, recordingRunner } from "../helpers/restore-fixtures.ts";

const native = nativeAvailable();
const exec = promisify(execFile);
const SWIFT_APP = path.join(os.homedir(), "Applications/Cairn.app/Contents/MacOS/Cairn");
const engine = () => new BackupEngine({ retentionKeep: keepVersions, macos: async () => "Version 15.0" });

async function open(dir: string): Promise<RestoreSource> {
  const s = await openRestoreSource(dir);
  if (!s) throw new Error(`not a backup: ${dir}`);
  return s;
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("restore", () => {
  test("reads_legacy_backup", async () => {
    await withTempDir(async (dir) => {
      const src = await open(legacyBackup(dir));
      expect(src.kind).toBe("legacy");
      expect(src.machine).toBe("Old Mac");
      expect(src.arch).toBe("arm64");
      expect(src.folders.map((f) => f.name)).toEqual(["workspaces"]);
      expect(src.aiTools).toEqual(["codex"]);
      expect(src.date).toEqual(new Date(2026, 10, 1, 10, 0, 0));
      const { tools, taps, brewfile } = await readToolLists(src.toolsDir!);
      expect(taps).toEqual(["hashicorp/tap"]);
      expect(brewfile).not.toBeNull();
      expect(tools.map((x) => x.name)).toEqual(["gh", "just", "@openai/codex", "ruff"]);
      expect(tools.at(-1)!.details.python).toBe("3.12");
      expect(installCommand(tools.at(-1)!)).toEqual([
        "uv",
        "tool",
        "install",
        "--force",
        "--python",
        "3.12",
        "ruff[lsp]",
      ]);
    });
  });

  test("reads_cairn_version", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "ws");
      writeFile(path.join(src, "p/a.txt"), 10);
      const dest = path.join(dir, "dest");
      const out = await engine().run({
        parts: [backupPart("folder", "folders/ws", src)],
        root: dest,
        retention: RECOMMENDED_RETENTION,
        dryRun: false,
        machine: "m",
      });
      const all = await versionsOnDestination(dest);
      expect(all.map((v) => v.version)).toEqual([out.version!]);
      const s = await open(all[0]!.path);
      expect(s.kind).toBe("cairn");
      expect(s.folders[0]?.originalPath).toBe(src);
      expect(archMatches(s)).toBe(true);
    });
  });

  test.skipIf(!native)("copy_keeps_pre_restore_and_fixes_secret_permissions", async () => {
    await withTempDir(async (dir) => {
      const bk = legacyBackup(dir);
      const home = path.join(dir, "home");
      put("local\n", path.join(home, ".zshrc"));
      const service = new RestoreService(await open(bk), {
        home,
        runner: recordingRunner().run,
        statePaths: { stateDir: path.join(dir, "state") },
      });
      const plan = { ...defaultPlan(), tools: false, folders: { workspaces: path.join(dir, "ws-target") } };
      const sim = await service.run(plan);
      expect(sim.every((s) => s.ok)).toBe(true);
      expect(readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("local\n"); // simulation : rien d'écrit
      expect(existsSync(path.join(dir, "ws-target"))).toBe(false); // ni la cible (e229e52)
      const res = await service.run(plan, { apply: true });
      expect(res.filter((s) => !s.ok)).toEqual([]);
      expect(readFileSync(path.join(home, ".zshrc.pre-restore"), "utf8")).toBe("local\n");
      expect(mode(path.join(home, ".ssh"))).toBe(0o700);
      expect(mode(path.join(home, ".ssh/id_ed25519"))).toBe(0o600);
      expect(mode(path.join(home, ".ssh/id_ed25519.pub"))).toBe(0o644);
      expect(existsSync(path.join(dir, "ws-target/proj/a.txt"))).toBe(true);
    });
  });

  test.skipIf(!native)("tools_reinstalled_in_order_and_failure_does_not_stop", async () => {
    await withTempDir(async (dir) => {
      const runner = recordingRunner();
      const asked: string[] = [];
      const service = new RestoreService(await open(legacyBackup(dir)), {
        home: dir,
        runner: runner.run,
        statePaths: { stateDir: path.join(dir, "state") },
        waitForAdmin: async (cmd) => {
          asked.push(cmd);
          return true;
        },
      });
      const res = await service.run({ ...defaultPlan(), home: false, folders: {}, ai: [] }, { apply: true });
      const installs = runner.commands.filter((c) => c[0] !== "/bin/sh" && !c[0]!.startsWith("/usr/bin"));
      expect(installs.map((c) => c[0])).toEqual(["brew", "brew", "brew", "mise", "uv"]);
      expect(installs).toEqual([
        ["brew", "tap", "hashicorp/tap"],
        ["brew", "install", "gh"],
        ["brew", "install", "just"],
        ["mise", "exec", "--", "npm", "install", "-g", "@openai/codex"],
        ["uv", "tool", "install", "--force", "--python", "3.12", "ruff[lsp]"],
      ]);
      expect(res.some((s) => s.step === "tool:@openai/codex" && !s.ok)).toBe(true); // échec npm noté
      expect(res.some((s) => s.step === "tool:ruff" && s.ok)).toBe(true); // les suivants sont installés
      // Spec « Homebrew absent » : la commande officielle est ouverte dans Terminal, attendue, puis la suite reprend.
      expect(asked).toEqual([HOMEBREW_INSTALL]);
      const steps = res.map((s) => s.step);
      expect(steps.indexOf("brew-install")).toBeLessThan(steps.indexOf("tool:gh"));
    });
  });

  test("check_changes_nothing", async () => {
    await withTempDir(async (dir) => {
      const runner = recordingRunner();
      const service = new RestoreService(await open(legacyBackup(dir)), { home: dir, runner: runner.run });
      const { present, missing } = await service.check();
      expect(present).toHaveLength(0);
      expect(missing).toHaveLength(4);
      expect(runner.commands.every((c) => c[0] === "/bin/sh")).toBe(true); // seulement des « command -v »
    });
  });

  test("legacy_mise_config_is_read", async () => {
    await withTempDir(async (dir) => {
      const bk = legacyBackup(dir);
      put(
        '[tools]\nnode = "22"\npython = ["3.12", "3.11"]\n"aqua:cli/cli" = "latest"\n',
        path.join(bk, "manifest/mise-config.toml"),
      );
      const { tools } = await readToolLists(path.join(bk, "manifest"));
      const mise = tools.filter((x) => x.source === "mise");
      expect(mise.map((x) => x.name)).toEqual(["node", "python", "aqua:cli/cli"]);
      expect(installCommand(mise[0]!)).toEqual(["mise", "use", "-g", "node@22"]);
      expect(mise[1]!.details.requested).toBe("3.12");
    });
  });

  test.skipIf(!native)("open_ai_tool_is_waited_for_or_skipped", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const asked: string[] = [];
      let quit = false;
      const deps = {
        home,
        runner: recordingRunner().run,
        statePaths: { stateDir: path.join(dir, "state") },
        isRunning: async () => true,
        waitForQuit: async (p: { id: string }) => {
          asked.push(p.id);
          return quit;
        },
      };
      const source = await open(legacyBackup(dir));
      const plan = { ...defaultPlan(), tools: false, home: false, ai: ["codex"] };
      const skipped = await new RestoreService(source, deps).run(plan, { apply: true });
      expect(asked).toEqual(["codex"]);
      expect(skipped.some((s) => s.step === "ai/codex" && !s.ok)).toBe(true);
      expect(existsSync(path.join(home, ".codex"))).toBe(false); // rien d'écrit tant que l'outil est ouvert
      quit = true;
      const done = await new RestoreService(source, deps).run(plan, { apply: true });
      expect(done.some((s) => s.step === "ai" && s.ok)).toBe(true);
      expect(existsSync(path.join(home, ".codex/config.toml"))).toBe(true);
    });
  });

  test.skipIf(!native)("legacy_home_copy_leaves_ai_data_to_the_merge", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const service = new RestoreService(await open(legacyBackup(dir)), {
        home,
        runner: recordingRunner().run,
        statePaths: { stateDir: path.join(dir, "state") },
      });
      const res = await service.run({ ...defaultPlan(), tools: false, ai: [] }, { apply: true });
      expect(res.filter((s) => !s.ok)).toEqual([]);
      expect(existsSync(path.join(home, ".zshrc"))).toBe(true);
      expect(existsSync(path.join(home, ".codex"))).toBe(false); // home seulement : pas de données IA
    });
  });

  test.skipIf(!native)("paths_that_cannot_be_rewritten_are_reported", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const service = new RestoreService(await open(legacyBackup(dir)), {
        home,
        runner: recordingRunner().run,
        statePaths: { stateDir: path.join(dir, "state") },
        isRunning: async () => false,
      });
      const plan = { ...defaultPlan(), tools: false, home: false, ai: ["codex"] };
      // Le home d'origine (/Users/old) diffère : les chemins internes de Codex ne sont pas réécrits.
      for (const apply of [false, true]) {
        const res = await service.run(plan, { apply });
        expect(res.some((s) => s.step === "ai:paths" && s.detail !== "")).toBe(true);
      }
      expect(await notRewritten("codex", "/Users/old", [["/Users/old", "/Users/old"]])).toEqual([]); // rien à signaler
    });
  });

  test("default_version_is_most_recent_and_prefers_this_mac", () => {
    const v = (m: string, name: string, partial = false): RestoreVersion => ({
      machine: m,
      version: name,
      path: `/d/${m}/${name}`,
      partial,
    });
    // Trié par machine (comme `versionsOnDestination`) : la dernière n'est pas la plus récente.
    const all = [v("Alpha", "2026-11-01T120000"), v("Zulu", "2025-01-01T120000")];
    expect(defaultVersion(all, "New")).toBe("/d/Alpha/2026-11-01T120000");
    expect(defaultVersion(all, "Zulu")).toBe("/d/Zulu/2025-01-01T120000");
    const twice = [v("Alpha", "2026-11-01T120000"), v("Zulu", "2026-11-01T120000")];
    expect(versionNamed("2026-11-01T120000", twice, "Zulu")).toBe("/d/Zulu/2026-11-01T120000");
    expect(versionNamed("absente", twice, "New")).toBeNull();
  });

  test("tool_names_from_backup_are_not_run_by_the_shell", async () => {
    await withTempDir(async (dir) => {
      const v = path.join(dir, "v");
      const marker = path.join(dir, "pwned");
      put('{"parts": []}', path.join(v, "manifest.json"));
      put(`[[npm]]\nname = "evil"\ncommands = ["x; touch ${marker}"]\n`, path.join(v, "tools/tools.toml"));
      // Vrai shell (lecture seule : `command -v`), pour prouver que le nom n'est pas interprété.
      const service = new RestoreService(await open(v), { home: dir, runner: systemRunner(dir) });
      const { missing } = await service.check();
      expect(missing).toEqual(["evil"]);
      expect(existsSync(marker)).toBe(false); // le nom n'est pas interprété par le shell
    });
  });

  // Spec `restore` modifiée, « Outil go » : listé à réinstaller à la main avec sa version, compté manquant à la fin.
  test.skipIf(!native)("go_and_local_bin_tools_are_manual_with_their_version", async () => {
    await withTempDir(async (dir) => {
      const v = path.join(dir, "v");
      put('{"parts": []}', path.join(v, "manifest.json"));
      put(
        'version = 1\ntaps = []\n\n[[go]]\nname = "gopls"\nversion = "v0.16.2"\ncommands = ["gopls"]\n\n' +
          '[[local-bin]]\nname = "mytool"\ncommands = ["mytool"]\n\n[[cargo]]\nname = "ripgrep"\ncommands = ["rg"]\n',
        path.join(v, "tools/tools.toml"),
      );
      const runner = recordingRunner();
      const service = new RestoreService(await open(v), {
        home: dir,
        runner: runner.run,
        statePaths: { stateDir: path.join(dir, "state") },
      });
      const plan = { ...defaultPlan(), home: false };
      const sim = await service.run(plan);
      const gopls = sim.find((s) => s.step === "tool:gopls")!;
      expect(gopls.ok).toBe(false);
      expect(gopls.manual).toEqual({ source: "go", name: "gopls", version: "v0.16.2" });
      expect(gopls.detail).toContain("v0.16.2");
      expect(sim.find((s) => s.step === "tool:mytool")?.manual).toEqual({
        source: "local-bin",
        name: "mytool",
        version: null,
      });
      const res = await service.run(plan, { apply: true });
      const installs = runner.commands.filter((c) => c[0] !== "/bin/sh" && !c[0]!.startsWith("/usr/bin"));
      expect(installs).toEqual([["cargo", "install", "ripgrep"]]); // go et local-bin : aucune tentative
      const check = res.at(-1)!;
      expect(check.step).toBe("check");
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("gopls");
      expect(check.detail).toContain("mytool");
      expect((await checkTools(path.join(v, "tools"), runner.run)).missing).toEqual(["ripgrep", "gopls", "mytool"]);
    });
  });

  // Compatibilité : une version écrite par le moteur TypeScript, restaurée en simulation puis pour de vrai dans un home
  // temporaire (home, dossier suivi, Codex, outils), avec `.pre-restore` et les droits des secrets.
  test.skipIf(!native)(
    "restores_a_version_written_by_the_typescript_engine",
    async () => {
      await withTempDir(async (dir) => {
        const oldHome = path.join(dir, "old-home");
        put("export A=1\n", path.join(oldHome, ".zshrc"));
        put("PRIVATE\n", path.join(oldHome, ".ssh/id_ed25519"));
        put("ssh-ed25519 AAAA\n", path.join(oldHome, ".ssh/id_ed25519.pub"));
        put('model = "x"\n', path.join(oldHome, ".codex/config.toml"));
        put("{}\n", path.join(oldHome, ".codex/sessions/2026/11/08/rollout-a.jsonl"));
        const src = path.join(dir, "projects");
        writeFile(path.join(src, "site/index.html"), 1234);
        writeFile(path.join(src, "notes/todo.md"), 64);
        const config = defaultConfig();
        config.folders = [folder(src)];
        config.home.include = [".zshrc", ".ssh"];
        config.ai = [{ id: "codex", categories: ["conversations", "config"] }];
        const dest = path.join(dir, "dest");
        config.destinations = [destination("disk", "local", { path: dest, encrypted: false })];
        const paths = new CairnPaths(path.join(dir, ".cairn"));
        const deps = defaultBackupDependencies({
          home: oldHome,
          machine: "m",
          secrets: new MemorySecrets(),
          macos: async () => "Version 15.0 (Build 24A335)",
          progressThrottleMs: 0,
          // Home simulé : ni le vrai home ni l'inventaire de cette machine.
          aiParts: ({ config: c, staging, warn }) => aiParts(c, staging, { home: oldHome, running: [], warn }),
          openToolsLogLine: async () => null,
          exportInventory: async (_c, out) => {
            mkdirSync(out, { recursive: true });
            await writeText(
              path.join(out, "tools.toml"),
              'version = 1\ntaps = []\n\n[[brew]]\nname = "gh"\ncommands = ["gh"]\n\n' +
                '[[go]]\nname = "gopls"\nversion = "v0.16.2"\ncommands = ["gopls"]\n',
            );
            await writeText(path.join(out, "Brewfile"), 'brew "gh"\n');
          },
        });
        const results = await new BackupService(paths, config, deps).run();
        expect(results[0]!.error).toBeNull();
        const [version] = await listVersions(versionsDir(dest, "m"));
        const source = await open(path.join(versionsDir(dest, "m"), version!));
        expect(source.kind).toBe("cairn");
        expect(source.aiTools).toEqual(["codex"]);
        expect(source.originalHome).toBe(oldHome);
        expect(source.folders.map((f) => [f.name, f.originalPath])).toEqual([["projects", src]]);
        expect(source.toolsDir).not.toBeNull();

        const home = path.join(dir, "new-home");
        put("local\n", path.join(home, ".zshrc"));
        const target = path.join(dir, "restored/projects");
        const runner = recordingRunner();
        const service = new RestoreService(source, {
          home,
          runner: runner.run,
          isRunning: async () => false,
          statePaths: { stateDir: paths.state },
          waitForAdmin: async () => true,
        });
        const plan = { ...defaultPlan(), ai: source.aiTools, folders: { projects: target } };
        const sizes = await service.sizes(plan);
        expect(Object.keys(sizes).sort()).toEqual(["ai/codex", "folders/projects", "home"]);
        expect(sizes["folders/projects"]!).toBeGreaterThan(0);

        const sim = await service.run(plan);
        expect(sim.filter((s) => !s.ok).map((s) => s.step)).toEqual(["tool:gopls"]); // réinstallation manuelle
        expect(readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("local\n");
        expect(existsSync(target)).toBe(false);
        expect(existsSync(path.join(home, ".codex"))).toBe(false);
        expect(runner.commands.every((c) => c[0] === "/bin/sh" || c[0] === "/usr/bin/xcode-select")).toBe(true);

        const res = await service.run(plan, { apply: true });
        expect(res.filter((s) => !s.ok).map((s) => s.step)).toEqual(["tool:gopls", "check"]);
        expect(readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("export A=1\n");
        expect(readFileSync(path.join(home, ".zshrc.pre-restore"), "utf8")).toBe("local\n");
        expect(mode(path.join(home, ".ssh"))).toBe(0o700);
        expect(mode(path.join(home, ".ssh/id_ed25519"))).toBe(0o600);
        expect(mode(path.join(home, ".ssh/id_ed25519.pub"))).toBe(0o644);
        expect(statSync(path.join(target, "site/index.html")).size).toBe(1234);
        expect(existsSync(path.join(target, "notes/todo.md"))).toBe(true);
        expect(readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe('model = "x"\n');
        expect(existsSync(path.join(home, ".codex/sessions/2026/11/08/rollout-a.jsonl"))).toBe(true);
        expect(existsSync(path.join(home, ".codex/profile.json"))).toBe(false);
        expect(runner.commands.filter((c) => c[0] === "brew")).toEqual([["brew", "install", "gh"]]);
        expect(res.find((s) => s.step === "ai:paths")?.detail).toBe(t("ai.restore.not_rewritten.codex"));
      });
    },
    120_000,
  );

  // Compatibilité : une version écrite par la 0.8.0 (`backup --only folders`, destination et configuration
  // temporaires), restaurée en simulation puis pour de vrai dans une cible temporaire.
  test.skipIf(!native || !existsSync(SWIFT_APP))(
    "restores_a_version_written_by_cairn_0_8_0",
    async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        for (let i = 0; i < 6; i++) writeFile(path.join(src, `d${i % 2}/f${i}.bin`), 1000 + i);
        const dest = path.join(dir, "dest");
        const cfgDir = path.join(dir, "cfg");
        mkdirSync(cfgDir);
        const config = defaultConfig();
        config.folders = [folder(src)];
        config.destinations = [destination("local", "local", { path: dest, encrypted: false })];
        const store = ConfigStore.forConfigFile(path.join(cfgDir, "config.toml"));
        await store.save(config);
        await exec(SWIFT_APP, ["--config", store.file, "backup", "--only", "folders", "--lang", "en-US"], {
          timeout: 120_000,
        });
        const machine = await machineName();
        const opened = await versionsOnDestination(dest);
        expect(opened.map((v) => v.machine)).toEqual([machine]);
        expect(opened[0]!.partial).toBe(true); // --only : version partielle, mais seule version
        const source = await open(defaultVersion(opened, machine)!);
        expect(source.kind).toBe("cairn");
        expect(source.folders.map((f) => [f.name, f.originalPath])).toEqual([["src", src]]);
        expect(archMatches(source)).toBe(true);
        const target = path.join(dir, "restored/src");
        put("mine\n", path.join(target, "d0/f0.bin"));
        const home = path.join(dir, "home");
        const service = new RestoreService(source, {
          home,
          runner: recordingRunner().run,
          statePaths: { stateDir: path.join(cfgDir, "state") },
        });
        const plan = { ...defaultPlan(), folders: { src: target } };
        expect((await service.run(plan)).filter((s) => !s.ok)).toEqual([]);
        expect(readFileSync(path.join(target, "d0/f0.bin"), "utf8")).toBe("mine\n"); // simulation
        expect(existsSync(home)).toBe(false);
        const res = await service.run(plan, { apply: true });
        expect(res.filter((s) => !s.ok)).toEqual([]);
        for (let i = 0; i < 6; i++) expect(statSync(path.join(target, `d${i % 2}/f${i}.bin`)).size).toBe(1000 + i);
        expect(readFileSync(path.join(target, "d0/f0.bin.pre-restore"), "utf8")).toBe("mine\n");
      });
    },
    180_000,
  );
});
