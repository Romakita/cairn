// Port des cas de ConfigWarningTests.swift qui touchent la configuration (1 à 5). Les autres cas du fichier Swift
// (inventaire, pluriels, durées, assistant) relèvent d'autres domaines.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyConfig,
  decodeConfig,
  defaultConfig,
  destination,
  folder,
  newConfigDocument,
} from "../../src/core/config.ts";
import { ConfigLoadError, ConfigSaveError, ConfigStore } from "../../src/core/config-store.ts";
import { currentLanguage, setLanguage, t } from "../../src/core/l10n.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { TOMLDocument } from "../../src/core/toml.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const permissions = async (p: string) => (await stat(p)).mode & 0o777;

describe("ConfigWarning", () => {
  // 1. ~/.cairn en 700, quel que soit le premier à le créer.
  test("cairn_dir_created_700_by_runlog_and_watcher", async () => {
    await withTempDir(async (dir) => {
      // Le journal d'exécution crée son dossier par `paths.prepare(paths.logs)`.
      const paths = new CairnPaths(path.join(dir, ".cairn"));
      await paths.prepare(paths.logs);
      expect(await permissions(paths.root)).toBe(0o700);
      expect(existsSync(paths.logs)).toBe(true);

      const other = new CairnPaths(path.join(dir, "other"));
      const watcher = await new ConfigStore(other).watch(() => {});
      watcher.cancel();
      expect(await permissions(other.root)).toBe(0o700);
    });
  });

  test("runlog_keeps_existing_root_permissions", async () => {
    // Avec --config, la racine est le dossier choisi par l'utilisateur : on n'y touche pas.
    await withTempDir(async (dir) => {
      const root = path.join(dir, "mine");
      await mkdir(root, { recursive: true, mode: 0o755 });
      const paths = new CairnPaths(root);
      await paths.prepare(paths.logs);
      expect(await permissions(root)).toBe(0o755);
      // Le store d'un --config ne la modifie pas non plus.
      await ConfigStore.forConfigFile(path.join(root, "c.toml")).save(defaultConfig());
      expect(await permissions(root)).toBe(0o755);
    });
  });

  // 2. Une erreur de syntaxe devient une erreur bloquante, avec sa ligne.
  test("syntax_error_becomes_blocking_issue_with_line", async () => {
    await withTempDir(async (dir) => {
      const store = new ConfigStore(new CairnPaths(dir));
      await writeFile(store.file, 'version = 1\nlanguage = "fr-FR"\n[schedule\nfrequency = "daily"\n');
      let error: unknown = null;
      try {
        await store.load();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigLoadError); // chargement refusé
      const issues = ConfigStore.issuesFor(error);
      expect(issues.length).toBe(1);
      expect(issues[0]?.severity).toBe("error");
      expect(issues[0]?.line).toBe(3);
      const saved = currentLanguage();
      try {
        setLanguage("fr-FR");
        const description = issues[0]?.description ?? "";
        expect(description.startsWith(`${t("config.issue.error")} ${t("config.issue.line", 3)}`)).toBe(true);
        // Catalogues chargés (tâche 3.4) : texte exact de la 0.8.0.
        if (t("config.issue.error") !== "config.issue.error")
          expect(description.startsWith("erreur ligne 3 : ")).toBe(true);
      } finally {
        setLanguage(saved);
      }
    });
  });

  // 3. Enregistrer depuis l'app n'écrase pas un fichier invalide.
  test("save_refuses_to_overwrite_invalid_file", async () => {
    await withTempDir(async (dir) => {
      const store = new ConfigStore(new CairnPaths(dir));
      const c = defaultConfig();
      c.folders = [folder(dir)];
      await store.save(c);
      for (const broken of ["# à corriger\nversion = 1\n[schedule\n", 'version = 1\n[schedule]\ntime = "25:00"\n']) {
        await writeFile(store.file, broken);
        const newer = structuredClone(c);
        newer.git.gc = false;
        let error: unknown = null;
        try {
          await store.save(newer);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(ConfigSaveError); // enregistrement refusé
        const issues = (error as ConfigSaveError).issues;
        expect(issues.length > 0 && issues.every((i) => i.severity === "error")).toBe(true);
        expect(await readFile(store.file, "utf8")).toBe(broken); // fichier non modifié
      }
      // Fichier absent : l'assistant peut toujours l'écrire.
      await rm(store.file);
      await store.save(c);
      expect((await store.load()).config.folders).toEqual(c.folders);
    });
  });

  // 4. Pas de clé `keychain` écrite ; l'ancienne reste lue sans erreur.
  test("smb_destination_has_no_keychain_key", () => {
    // Destination smb telle que l'assistant la crée (`OnboardingDraft.makeConfig`) : sans `keychain`.
    const c = defaultConfig();
    c.destinations = [destination("main", "smb", { url: "smb://nas.local/backups", username: "romain" })];
    const text = newConfigDocument(c).render();
    expect(text).not.toContain("keychain =");
    const legacy = [
      "version = 1",
      "[[destinations]]",
      'id = "main"',
      'provider = "smb"',
      'url = "smb://nas.local/backups"',
      'username = "romain"',
      'keychain = "main"',
      "",
    ].join("\n");
    const doc = TOMLDocument.parse(legacy);
    const { config, issues } = decodeConfig(doc);
    expect(issues).toEqual([]);
    expect(config.destinations[0]?.keychain).toBe("main");
    applyConfig(config, doc);
    expect(doc.render()).toContain('keychain = "main"'); // ancienne clé conservée
  });

  // 5. Désélectionner un outil IA retire sa table, sans toucher aux commentaires.
  test("deselected_ai_tool_table_is_removed", () => {
    const doc = TOMLDocument.parse(
      [
        "# Mon fichier",
        "version = 1",
        "",
        "# Outils IA suivis",
        "[ai.claude-code]",
        'categories = ["config"]',
        "",
        "[ai.codex]",
        'categories = ["conversations", "config"]',
        "",
        "# Planification",
        "[schedule]",
        'frequency = "daily"',
        "",
      ].join("\n"),
    );
    const c = decodeConfig(doc).config;
    expect(c.ai.map((a) => a.id)).toEqual(["claude-code", "codex"]);
    c.ai = c.ai.filter((a) => a.id !== "codex");
    applyConfig(c, doc);
    const text = doc.render();
    expect(text).not.toContain("codex");
    for (const comment of ["# Mon fichier", "# Outils IA suivis", "# Planification"]) expect(text).toContain(comment);
    const back = decodeConfig(TOMLDocument.parse(text)).config;
    expect(back.ai.map((a) => a.id)).toEqual(["claude-code"]);
    expect(text).not.toContain("\n\n\n");

    // Forme pointée sous [ai] : removeTable retire aussi les clés `codex.…`.
    const dotted = TOMLDocument.parse('[ai]\ncodex.categories = ["config"]\nclaude-code.categories = ["config"]\n');
    dotted.removeTable(["ai", "codex"]);
    expect(dotted.render()).toBe('[ai]\nclaude-code.categories = ["config"]\n');
  });
});
