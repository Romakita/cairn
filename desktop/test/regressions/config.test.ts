// Régressions de parity/behavior.md §2 qui touchent la configuration : un test par commit (ou fichier de tests Swift).
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeConfig, defaultConfig, destination, folder } from "../../src/core/config.ts";
import { ConfigSaveError, ConfigStore } from "../../src/core/config-store.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { asString, TOML, TOMLDocument } from "../../src/core/toml.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return null;
}

describe("régressions : configuration", () => {
  test("ConfigWarningTests: refuse d'écraser un config.toml invalide", async () => {
    await withTempDir(async (dir) => {
      const store = new ConfigStore(new CairnPaths(dir));
      await store.save(defaultConfig());
      const broken = '# corrigé à la main\nversion = 1\n[schedule]\nweekday = "lundi"\n';
      await writeFile(store.file, broken);
      const error = await rejection(store.save(defaultConfig()));
      expect(error).toBeInstanceOf(ConfigSaveError);
      expect((error as ConfigSaveError).issues.map((i) => [i.key, i.line])).toEqual([["schedule.weekday", 4]]);
      expect(await readFile(store.file, "utf8")).toBe(broken);
    });
  });

  test("TOMLTests: un fichier CRLF se lit (le commentaire n'avale pas la suite) et garde ses \\r\\n", () => {
    const text = '# Cairn\r\nversion = 1\r\n\r\n[schedule]\r\ntime = "12:30" # midi\r\n';
    const doc = TOMLDocument.parse(text);
    expect(doc.render()).toBe(text);
    const { config, issues } = decodeConfig(doc);
    expect(issues).toEqual([]);
    expect(config.schedule.time).toBe("12:30");
    doc.set(TOML.string("08:00"), ["time"], ["schedule"]);
    expect(doc.render()).toBe('# Cairn\r\nversion = 1\r\n\r\n[schedule]\r\ntime = "08:00" # midi\r\n');
  });

  test("46a9475: config.toml CRLF réécrit par le store sans perdre ses fins de ligne", async () => {
    await withTempDir(async (dir) => {
      const store = new ConfigStore(new CairnPaths(dir));
      await writeFile(store.file, '# à moi\r\nversion = 1\r\nlanguage = "auto"\r\n');
      const c = (await store.load()).config;
      c.language = "fr-FR";
      await store.save(c);
      const out = await readFile(store.file, "utf8");
      expect(out.startsWith('# à moi\r\nversion = 1\r\nlanguage = "fr-FR"\r\n')).toBe(true);
      expect(asString(TOMLDocument.parse(out).tree().value("language"))).toBe("fr-FR");
    });
  });

  test("156f978: une destination locale au chemin vide est refusée", () => {
    const { issues } = decodeConfig(
      TOMLDocument.parse('version = 1\n[[destinations]]\nid = "disk"\nprovider = "local"\npath = ""\n'),
    );
    expect(issues.filter((i) => i.severity === "error").map((i) => [i.key, i.line])).toEqual([
      ["destinations[0].path", 2],
    ]);
  });

  test("76e40ec: un échec d'écriture de config.toml est remonté, le fichier reste intact", async () => {
    if (process.getuid?.() === 0) return; // root écrit partout
    await withTempDir(async (dir) => {
      // Dossier d'un --config en lecture seule (`~/.cairn`, lui, serait remis en 700 avant l'écriture).
      const folderPath = path.join(dir, "conf");
      const store = ConfigStore.forConfigFile(path.join(folderPath, "config.toml"));
      const c = defaultConfig();
      c.folders = [folder(dir)];
      await store.save(c);
      const before = await readFile(store.file, "utf8");
      await chmod(folderPath, 0o500);
      try {
        const next = structuredClone(c);
        next.destinations = [destination("disk", "local", { path: dir })];
        expect(await rejection(store.save(next))).toBeInstanceOf(Error);
      } finally {
        await chmod(folderPath, 0o700);
      }
      expect(await readFile(store.file, "utf8")).toBe(before);
      expect((await readdir(folderPath)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
  });
});
