// Restauration des données IA (AIRestore) : port des cas `restore_merges_and_rewrites_claude_projects` et
// `legacy_backup_ai_data` d'AITests.swift, plus les règles de fusion de parity/behavior.md §1.6 (absent → copié, même
// taille et mtime < 1 s → rien, plus récent → l'autre en `.pre-restore`, `meta/` jamais fusionné, `.claude.json` qui
// cite l'ancien chemin signalé). Home simulé dans un dossier temporaire.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { BUNDLED_PROFILES } from "../../src/core/ai/profiles.ts";
import { t } from "../../src/core/l10n.ts";
import {
  claudeProjectName,
  emptyReport,
  merge,
  notRewritten,
  restoreLegacy,
  restoreTool,
} from "../../src/core/restore/ai-restore.ts";
import { withTempDir, writeFile } from "../helpers/backup-env.ts";
import { put } from "../helpers/restore-fixtures.ts";

const profile = (id: string) => BUNDLED_PROFILES.find((p) => p.id === id)!;

function setMtime(file: string, date: Date): void {
  utimesSync(file, date, date);
}

function makeDB(file: string, rows: number): void {
  const sql = ["CREATE TABLE t(x INTEGER);", ...Array.from({ length: rows }, (_, i) => `INSERT INTO t VALUES(${i});`)];
  execFileSync("/usr/bin/sqlite3", [file, sql.join(" ")]);
}

describe("ai-restore", () => {
  test("restore_merges_and_rewrites_claude_projects", async () => {
    await withTempDir(async (dir) => {
      const saved = path.join(dir, "version/ai/claude-code");
      const old = path.join(saved, "conversations/.claude/projects/-Volumes-workspaces-exports");
      writeFile(path.join(old, "older.jsonl"), 100);
      writeFile(path.join(old, "newer.jsonl"), 100);
      writeFile(path.join(old, "only-saved.jsonl"), 100);
      const home = path.join(dir, "home");
      const local = path.join(home, ".claude/projects/-Volumes-workspaces-exports");
      writeFile(path.join(local, "older.jsonl"), 50);
      writeFile(path.join(local, "newer.jsonl"), 50);
      setMtime(path.join(local, "older.jsonl"), new Date(Date.now() - 86_400_000));
      setMtime(path.join(local, "newer.jsonl"), new Date(Date.now() + 3_600_000));
      const report = await restoreTool(saved, profile("claude-code"), {
        home,
        replaceDatabases: false,
        prefixes: [["/Volumes/workspaces", `${home}/workspaces`]],
      });
      expect(report.added).toBe(1);
      expect(report.replacedOlder).toBe(1);
      expect(report.keptNewer).toBe(1);
      const renamed = path.join(home, ".claude/projects", claudeProjectName(`${home}/workspaces/exports`));
      expect(existsSync(path.join(renamed, "only-saved.jsonl"))).toBe(true); // dossier de projet réécrit
      expect(statSync(path.join(renamed, "newer.jsonl")).size).toBe(50); // locale plus récente gardée
      expect(existsSync(path.join(renamed, "newer.jsonl.pre-restore"))).toBe(true); // sauvegardée écrite à côté
      expect(existsSync(path.join(renamed, "older.jsonl.pre-restore"))).toBe(true); // ancienne locale gardée
      expect(claudeProjectName("/Volumes/workspaces/exports")).toBe("-Volumes-workspaces-exports");
    });
  });

  test("legacy_backup_ai_data", async () => {
    await withTempDir(async (dir) => {
      const bk = path.join(dir, "bk");
      writeFile(path.join(bk, "home/.codex/config.toml"), 100);
      mkdirSync(path.join(bk, "ai/sqlite/.codex"), { recursive: true });
      makeDB(path.join(bk, "ai/sqlite/.codex/state_5.sqlite"), 5);
      writeFile(path.join(bk, "ai/claude-desktop/Claude/config.json"), 50);
      const home = path.join(dir, "home");
      writeFile(path.join(home, ".codex/state_5.sqlite-wal"), 10);
      const r = await restoreLegacy(bk, new Set(["codex", "claude-desktop"]), { home, replaceDatabases: true });
      expect(r.databases).toBe(1);
      expect(existsSync(path.join(home, ".codex/config.toml"))).toBe(true);
      expect(existsSync(path.join(home, ".codex/state_5.sqlite-wal"))).toBe(false); // -wal retiré avant de poser la base
      expect(existsSync(path.join(home, "Library/Application Support/Claude/config.json"))).toBe(true);
      const rows = execFileSync("/usr/bin/sqlite3", [
        path.join(home, ".codex/state_5.sqlite"),
        "SELECT count(*) FROM t",
      ]);
      expect(rows.toString().trim()).toBe("5");
    });
  });

  test("merge_rules_and_meta_never_merged", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      writeFile(path.join(src, "same.txt"), 10);
      writeFile(path.join(dest, "same.txt"), 10);
      const when = new Date(Date.now() - 10_000);
      setMtime(path.join(src, "same.txt"), when);
      setMtime(path.join(dest, "same.txt"), new Date(when.getTime() + 400)); // < 1 s d'écart
      put("new", path.join(src, "a/b/added.txt"));
      const report = emptyReport();
      await merge(src, dest, report);
      expect(report).toMatchObject({ added: 1, replacedOlder: 0, keptNewer: 0 });
      expect(existsSync(path.join(dest, "same.txt.pre-restore"))).toBe(false); // identique : rien
      expect(readFileSync(path.join(dest, "a/b/added.txt"), "utf8")).toBe("new");
      // La copie garde la date : une deuxième fusion ne change rien.
      const again = emptyReport();
      await merge(src, dest, again);
      expect(again).toMatchObject({ added: 0, replacedOlder: 0, keptNewer: 0 });

      // `meta/` (profil, snapshots) n'est pas une catégorie : jamais fusionné dans le dossier de l'outil.
      const tool = path.join(dir, "ai/codex");
      put("{}", path.join(tool, "meta/profile.json"));
      put("x", path.join(tool, "config/config.toml"));
      const home = path.join(dir, "home");
      await restoreTool(tool, profile("codex"), { home, replaceDatabases: false });
      expect(existsSync(path.join(home, ".codex/config.toml"))).toBe(true);
      expect(existsSync(path.join(home, ".codex/profile.json"))).toBe(false);
      expect(existsSync(path.join(home, ".codex/meta"))).toBe(false);
    });
  });

  test("legacy_claude_json_is_merged_and_old_paths_reported", async () => {
    await withTempDir(async (dir) => {
      const bk = path.join(dir, "bk");
      put('{"projects": {"/Users/old/ws/app": {}}}', path.join(bk, "home/.claude.json"));
      put("c", path.join(bk, "home/.claude/projects/-Users-old-ws-app/c.jsonl"));
      const home = path.join(dir, "home");
      const prefixes = [["/Users/old", home]] as const;
      const r = await restoreLegacy(bk, new Set(["claude-code"]), { home, replaceDatabases: false, prefixes });
      expect(readFileSync(path.join(home, ".claude.json"), "utf8")).toContain("/Users/old/ws/app");
      expect(r.renamedProjects).toEqual([`${claudeProjectName(home)}-ws-app`]);
      expect(existsSync(path.join(home, ".claude/projects", `${claudeProjectName(home)}-ws-app/c.jsonl`))).toBe(true);
      expect(r.notRewritten).toEqual([
        t("ai.restore.not_rewritten.claude_sessions"),
        t("ai.restore.not_rewritten.claude_json"),
      ]);
      // Sans changement de chemin : rien à signaler.
      expect(await notRewritten("claude-code", home, [[home, home]])).toEqual([]);
      expect(await notRewritten("claude-desktop", home, prefixes)).toEqual([
        t("ai.restore.not_rewritten.claude_desktop"),
      ]);
    });
  });
});
