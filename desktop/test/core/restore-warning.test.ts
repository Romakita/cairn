// Port des cas de restauration de RestoreWarningTests.swift (mêmes cas, mêmes attentes). Les cas IA de sauvegarde
// (profils ajoutés, outils ouverts, plugins, identifiants, taille sauvegardée) sont dans ai.test.ts ; le cas CLI
// `cli_restore_tool_option` relève des tests de la commande `cairn restore`. Home simulé, exécuteurs factices.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aiParts } from "../../src/core/ai/backup.ts";
import { BUNDLED_PROFILES } from "../../src/core/ai/profiles.ts";
import { BackupEngine } from "../../src/core/backup/engine.ts";
import { backupPart } from "../../src/core/backup/types.ts";
import { versionsDir } from "../../src/core/backup/versions.ts";
import { defaultConfig, RECOMMENDED_RETENTION } from "../../src/core/config.ts";
import { t } from "../../src/core/l10n.ts";
import {
  archMatches,
  COMMAND_LINE_TOOLS_INSTALL,
  claudeProjectName,
  currentArch,
  defaultPlan,
  emptyReport,
  openRestoreSource,
  RestoreService,
  type RestoreSource,
  restoreTool,
  rewriteClaudeProjects,
  targetIsMissing,
  waitForCommandLineTools,
} from "../../src/core/restore/index.ts";
import { keepVersions } from "../../src/core/retention.ts";
import { withTempDir, writeFile } from "../helpers/backup-env.ts";
import { nativeAvailable } from "../helpers/native.ts";
import { cltRunner, FakeClock, legacyBackupWithAI, put } from "../helpers/restore-fixtures.ts";

const native = nativeAvailable();
const engine = () => new BackupEngine({ retentionKeep: keepVersions, macos: async () => "Version 15.0" });

async function open(dir: string): Promise<RestoreSource> {
  const s = await openRestoreSource(dir);
  if (!s) throw new Error(`not a backup: ${dir}`);
  return s;
}

describe("restore-warning", () => {
  test("missing_target_checks_the_volume_itself", async () => {
    const onlyVolumes = (p: string) => p === "/Volumes" || p === "/Users/r";
    expect(await targetIsMissing("/Volumes/workspaces", onlyVolumes)).toBe(true);
    expect(await targetIsMissing("/Volumes/workspaces/projets/a", onlyVolumes)).toBe(true);
    const mounted = (p: string) => p === "/Volumes" || p === "/Volumes/workspaces";
    expect(await targetIsMissing("/Volumes/workspaces", mounted)).toBe(false);
    expect(await targetIsMissing("/Volumes/workspaces/projets/a", mounted)).toBe(false); // le dossier sera créé
    expect(await targetIsMissing("/Users/r/ws", onlyVolumes)).toBe(false);
    expect(await targetIsMissing("/Users/x/ws", onlyVolumes)).toBe(true);
  });

  test.skipIf(!native)("command_line_tools_before_homebrew_and_final_check", async () => {
    await withTempDir(async (dir) => {
      const source = await open(legacyBackupWithAI(dir));
      const plan = { ...defaultPlan(), home: false, ai: [] };
      const statePaths = { stateDir: path.join(dir, "state") };
      let asked: string[] = [];
      const waitForAdmin = async (cmd: string) => {
        asked.push(cmd);
        return true;
      };
      const res = await new RestoreService(source, {
        home: dir,
        runner: cltRunner(false).run,
        statePaths,
        waitForAdmin,
      }).run(plan, { apply: true });
      expect(asked[0]).toBe(COMMAND_LINE_TOOLS_INSTALL);
      expect(asked).toHaveLength(2); // puis Homebrew
      const steps = res.map((s) => s.step);
      expect(steps.indexOf("command-line-tools")).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf("command-line-tools")).toBeLessThan(steps.indexOf("brew-install"));
      expect(steps.at(-1)).toBe("check"); // vérification finale
      const last = res.at(-1)!;
      expect(last.ok).toBe(false);
      expect(last.detail).toContain("gh"); // gh manquant
      // Simulation : rien n'est lancé, l'étape est annoncée ; installés : étape « present ».
      asked = [];
      const sim = await new RestoreService(source, { home: dir, runner: cltRunner(false).run, waitForAdmin }).run(plan);
      expect(asked).toEqual([]);
      expect(sim.some((s) => s.step === "command-line-tools" && s.ok)).toBe(true);
      expect(sim.some((s) => s.step === "check")).toBe(false); // pas de vérification en simulation
      const ok = await new RestoreService(source, {
        home: dir,
        runner: cltRunner(true).run,
        statePaths,
        waitForAdmin,
      }).run(plan, { apply: true });
      expect(ok.find((s) => s.step === "command-line-tools")?.detail).toBe(t("restore.detail.present"));
      expect(asked).not.toContain(COMMAND_LINE_TOOLS_INSTALL);
      const clock = new FakeClock();
      expect(
        await waitForCommandLineTools({ runner: cltRunner(true).run, clock, commandLineToolsTimeoutMs: 1000 }),
      ).toBe(true);
    });
  });

  test("claude_project_name_replaces_every_non_alphanumeric", () => {
    expect(claudeProjectName("/Users/r/my_proj v2.0@x")).toBe("-Users-r-my-proj-v2-0-x");
    expect(claudeProjectName("/Volumes/workspaces/exports/.claude/worktrees/a")).toBe(
      "-Volumes-workspaces-exports--claude-worktrees-a",
    );
  });

  test("legacy_sizes_measure_the_tool_folders", async () => {
    await withTempDir(async (dir) => {
      const service = new RestoreService(await open(legacyBackupWithAI(dir)), { home: dir });
      const s = await service.sizes({ ...defaultPlan(), ai: ["claude-code", "codex", "claude-desktop"], folders: {} });
      expect(s["ai/claude-code"]!).toBeGreaterThanOrEqual(200_000);
      expect(s["ai/codex"]!).toBeGreaterThanOrEqual(50_000);
      expect(s["ai/codex"]!).toBeLessThan(200_000);
      expect(s["ai/claude-desktop"]!).toBeGreaterThanOrEqual(30_000);
      expect(s["ai/claude-desktop"]!).toBeLessThan(50_000);
      expect(s.home!).toBeLessThan(50_000); // home sans les dossiers IA
    });
  });

  test("other_arch_is_flagged", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "ws");
      writeFile(path.join(src, "a.txt"), 10);
      const dest = path.join(dir, "dest");
      const out = await engine().run({
        parts: [backupPart("folder", "folders/ws", src)],
        root: dest,
        retention: RECOMMENDED_RETENTION,
        dryRun: false,
        machine: "m",
      });
      const v = path.join(versionsDir(dest, "m"), out.version!);
      const file = path.join(v, "manifest.json");
      const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      m.arch = currentArch() === "arm64" ? "x86_64" : "arm64";
      writeFileSync(file, JSON.stringify(m));
      expect(archMatches(await open(v))).toBe(false);
    });
  });

  test.skipIf(!native)("ai_merge_end_to_end_from_a_cairn_version", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "old-home");
      writeFile(path.join(home, ".codex/sessions/2026/11/08/rollout-a.jsonl"), 500);
      writeFile(path.join(home, ".codex/config.toml"), 100);
      writeFile(path.join(home, ".codex/auth.json"), 100);
      const c = defaultConfig();
      c.ai = [{ id: "codex", categories: ["conversations", "config"] }];
      const parts = await aiParts(c, path.join(dir, "staging"), { home, running: [] });
      const dest = path.join(dir, "dest");
      const out = await engine().run({
        parts,
        root: dest,
        retention: RECOMMENDED_RETENTION,
        dryRun: false,
        machine: "m",
      });
      const source = await open(path.join(versionsDir(dest, "m"), out.version!));
      expect(source.aiTools).toEqual(["codex"]);
      const newHome = path.join(dir, "new-home");
      put("local\n", path.join(newHome, ".codex/history.jsonl"));
      const service = new RestoreService(source, {
        home: newHome,
        isRunning: async () => false,
        statePaths: { stateDir: path.join(dir, "state") },
      });
      const plan = { ...defaultPlan(), tools: false, home: false, ai: ["codex"] };
      const sim = await service.run(plan);
      expect(sim.some((s) => s.step === "ai" && s.ok)).toBe(true);
      expect(existsSync(path.join(newHome, ".codex/config.toml"))).toBe(false); // simulation
      const res = await service.run(plan, { apply: true });
      expect(res.filter((s) => !s.ok)).toEqual([]);
      expect(existsSync(path.join(newHome, ".codex/config.toml"))).toBe(true);
      expect(existsSync(path.join(newHome, ".codex/sessions/2026/11/08/rollout-a.jsonl"))).toBe(true);
      expect(readFileSync(path.join(newHome, ".codex/history.jsonl"), "utf8")).toBe("local\n"); // fichier local gardé
      expect(existsSync(path.join(newHome, ".codex/auth.json"))).toBe(false); // identifiants non sauvegardés
      expect(existsSync(path.join(newHome, ".codex/profile.json"))).toBe(false); // meta non fusionné
    });
  });

  test("missing_databases_are_restored_existing_ones_only_on_request", async () => {
    await withTempDir(async (dir) => {
      // Version Cairn de Codex avec deux bases : une absente du Mac, une déjà présente (avec son WAL).
      const tool = path.join(dir, "ai/codex");
      put("snap-a", path.join(tool, "meta/sqlite/conversations/state_5.sqlite"));
      put("snap-b", path.join(tool, "meta/sqlite/conversations/thread_history_1.sqlite"));
      const home = path.join(dir, "home");
      const codex = path.join(home, ".codex");
      put("local-b", path.join(codex, "thread_history_1.sqlite"));
      put("wal-b", path.join(codex, "thread_history_1.sqlite-wal"));
      const p = BUNDLED_PROFILES.find((x) => x.id === "codex")!;
      const r1 = await restoreTool(tool, p, { home, replaceDatabases: false });
      expect(r1.databases).toBe(1);
      expect(readFileSync(path.join(codex, "state_5.sqlite"), "utf8")).toBe("snap-a"); // absente : restaurée
      expect(readFileSync(path.join(codex, "thread_history_1.sqlite"), "utf8")).toBe("local-b"); // présente : gardée
      const r2 = await restoreTool(tool, p, { home, replaceDatabases: true });
      expect(r2.databases).toBe(2);
      expect(readFileSync(path.join(codex, "thread_history_1.sqlite"), "utf8")).toBe("snap-b");
      expect(readFileSync(path.join(codex, "thread_history_1.sqlite.pre-restore"), "utf8")).toBe("local-b");
      // Le WAL de l'ancienne base est gardé avec elle.
      expect(readFileSync(path.join(codex, "thread_history_1.sqlite.pre-restore-wal"), "utf8")).toBe("wal-b");
    });
  });

  test("project_folder_kept_when_merge_fails", async () => {
    await withTempDir(async (dir) => {
      const projects = path.join(dir, "projects");
      // Ancien dossier : « x » est un dossier ; dans le dossier cible existant, « x » est un fichier → la fusion échoue.
      put("conv", path.join(projects, "-Users-old-ws/x/conv.jsonl"));
      put("file", path.join(projects, "-Users-new-ws/x"));
      const report = emptyReport();
      await rewriteClaudeProjects(projects, [["/Users/old", "/Users/new"]], report);
      expect(existsSync(path.join(projects, "-Users-old-ws/x/conv.jsonl"))).toBe(true); // rien n'est supprimé
      expect(report.notRewritten).toHaveLength(1);
      expect(report.renamedProjects).toEqual([]);
    });
  });

  test("longest_prefix_wins_for_project_folders", async () => {
    await withTempDir(async (dir) => {
      const projects = path.join(dir, "projects");
      put("c", path.join(projects, "-Users-old-ws-app/c.jsonl"));
      put("c", path.join(projects, "-Users-old-notes/c.jsonl"));
      const report = emptyReport();
      await rewriteClaudeProjects(
        projects,
        [
          ["/Users/old", "/Users/new"],
          ["/Users/old/ws", "/Volumes/ws"],
        ],
        report,
      );
      expect(report.renamedProjects.sort()).toEqual(["-Users-new-notes", "-Volumes-ws-app"]);
    });
  });
});
