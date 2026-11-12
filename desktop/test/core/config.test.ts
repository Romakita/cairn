import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyConfig,
  type CairnConfig,
  type ConfigIssue,
  decodeConfig,
  defaultConfig,
  destination,
  folder,
  folderIsAvailable,
  newConfigDocument,
} from "../../src/core/config.ts";
import { pruneLogs } from "../../src/core/config-logs.ts";
import {
  genericPassword,
  imagePassword,
  imagePasswordService,
  KEYCHAIN_SERVICE_PREFIX,
  keychainLabel,
  setGenericPassword,
  setImagePassword,
  setSmbPassword,
  smbPassword,
} from "../../src/core/config-secrets.ts";
import { ConfigStore } from "../../src/core/config-store.ts";
import { setMachineName } from "../../src/core/machine.ts";
import { type NativeBinding, setNative } from "../../src/core/native.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { TOMLDocument } from "../../src/core/toml.ts";

const exampleFile = fileURLToPath(new URL("../../resources/config.example.toml", import.meta.url));

function decode(text: string): { config: CairnConfig; issues: ConfigIssue[] } {
  return decodeConfig(TOMLDocument.parse(text));
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Trousseau factice : mots de passe génériques et Internet en mémoire, libellés notés. */
function fakeKeychain() {
  const generic = new Map<string, { password: string; label: string }>();
  const internet = new Map<string, string>();
  const fake: Partial<NativeBinding> = {
    keychainGetGeneric: async (q) => generic.get(`${q.service}\0${q.account}`)?.password ?? null,
    keychainSetGeneric: async (q, password, label) => {
      const id = `${q.service}\0${q.account}`;
      generic.set(id, { password, label: generic.get(id)?.label ?? label });
    },
    keychainGetInternet: async (q) => internet.get(`${q.server}\0${q.account}\0${q.protocol}`) ?? null,
    keychainSetInternet: async (q, password) => {
      internet.set(`${q.server}\0${q.account}\0${q.protocol}`, password);
    },
  };
  setNative(fake as NativeBinding);
  return { generic, internet };
}

describe("Config", () => {
  test("example_file_is_valid", async () => {
    const loaded = await new ConfigStore(undefined, exampleFile).load();
    expect(loaded.hasErrors).toBe(false);
    expect(loaded.migrated).toBe(false);
    expect(loaded.config.destinations[0]?.retention).toEqual({ mode: "tiered", days: 30, weeks: 48 });
    expect(loaded.config.ai.map((a) => a.id)).toEqual(["claude-code", "codex"]);
    expect(loaded.config.schedule.frequency).toBe("daily");
  });

  test("defaults", () => {
    const { config: c, issues } = decode("version = 1\n");
    expect(issues).toEqual([]);
    expect(c.analysis.bigFileThresholdMB).toBe(50);
    expect(c.schedule.frequency).toBe("daily");
    expect(c.schedule.background).toBe(false);
    expect(c.logRetentionDays).toBe(90);
    expect(c.git.worktreeStaleDays).toBe(30);
  });

  test("unknown_keys_are_warnings_with_line", () => {
    const { issues } = decode('version = 1\nfoo = 1\n[schedule]\nfrequency = "weekly"\nbar = 2\n');
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    expect(issues.find((i) => i.key === "foo")?.line).toBe(2);
    expect(issues.find((i) => i.key === "schedule.bar")?.line).toBe(5);
  });

  test("type_error_reports_key_and_line", () => {
    const { issues } = decode("version = 1\n\n[schedule]\nfrequency = 3\n");
    const e = issues.find((i) => i.severity === "error");
    expect(e?.key).toBe("schedule.frequency");
    expect(e?.line).toBe(4);
  });

  test("invalid_values_are_errors", () => {
    const text = [
      "version = 1",
      'language = "de-DE"',
      "[[destinations]]",
      'id = "nas"',
      'provider = "smb"',
      'url = "http://nas"',
      'retention = { mode = "count", count = 0 }',
      "[schedule]",
      'time = "25:00"',
    ].join("\n");
    const { issues } = decode(text);
    const keys = new Set(issues.filter((i) => i.severity === "error").map((i) => i.key));
    for (const k of ["language", "destinations[0].url", "destinations[0].retention", "schedule.time"]) {
      expect(keys.has(k)).toBe(true);
    }
  });

  test("missing_folder_is_unavailable_not_error", () => {
    const { config: c, issues } = decode(
      'version = 1\n[[folders]]\npath = "/nonexistent-cairn"\n[[folders]]\npath = "/tmp"\n',
    );
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    expect(issues.filter((i) => i.severity === "warning").map((i) => i.key)).toEqual(["folders[0].path"]);
    expect(c.folders.map(folderIsAvailable)).toEqual([false, true]);
  });

  test("writer_roundtrip", () => {
    const c = defaultConfig();
    c.language = "fr-FR";
    c.folders = [folder("/tmp", { exclude: ["*.iso"] })];
    c.home.include = [".zshrc", ".ssh"];
    c.ai = [{ id: "codex", categories: ["conversations", "config"] }];
    c.destinations = [
      destination("nas", "smb", {
        url: "smb://nas.local/b",
        username: "r",
        keychain: "nas",
        retention: { mode: "count", count: 12 },
      }),
    ];
    c.schedule.frequency = "weekly";
    c.schedule.background = true;
    const { config: back, issues } = decode(newConfigDocument(c).render());
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    expect(back).toEqual(c);
  });

  test("writer_keeps_comments_and_unknown_keys", async () => {
    const original = `${await readFile(exampleFile, "utf8")}\n[custom]\nmine = "à moi"\n`;
    const doc = TOMLDocument.parse(original);
    const { config: c } = decodeConfig(doc);
    c.folders.push(folder("/tmp", { backup: false }));
    c.schedule.time = "08:00";
    applyConfig(c, doc);
    const out = doc.render();
    expect(out).toContain("# Dossiers suivis : analysés et, si backup = true, sauvegardés.");
    expect(out).toContain('time = "08:00"');
    expect(out).toContain('mine = "à moi"');
    const { config: back } = decodeConfig(TOMLDocument.parse(out));
    expect(back.folders.map((f) => f.path)).toEqual(["/Volumes/workspaces", "/tmp"]);
  });

  test("migration_v0_keeps_backup", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(path.join(dir, ".cairn"));
      await paths.ensure();
      const v0 = '# ancienne configuration\nroot_path = "/Volumes/workspaces"\n';
      await writeFile(paths.config, v0);
      const loaded = await new ConfigStore(paths).load();
      expect(loaded.migrated).toBe(true);
      expect(loaded.config.version).toBe(1);
      expect(loaded.config.folders.map((f) => f.path)).toEqual(["/Volumes/workspaces"]);
      expect(await readFile(`${paths.config}.bak`, "utf8")).toBe(v0);
      const migrated = await readFile(paths.config, "utf8");
      expect(migrated).toContain("version = 1");
      expect(migrated).not.toContain("root_path");
      expect(migrated).toContain("# ancienne configuration");
      const again = await new ConfigStore(paths).load();
      expect(again.migrated).toBe(false); // deuxième chargement sans migration
    });
  });

  test("save_creates_private_folder", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(path.join(dir, ".cairn"));
      await new ConfigStore(paths).save(defaultConfig());
      expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
      const reloaded = await new ConfigStore(paths).load();
      expect(reloaded.hasErrors).toBe(false);
    });
  });

  test("watcher_detects_manual_edit", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(dir);
      const store = new ConfigStore(paths);
      await store.save(defaultConfig());
      let resolveChange: () => void = () => {};
      const changed = new Promise<void>((resolve) => {
        resolveChange = resolve;
      });
      const watcher = await store.watch(() => resolveChange());
      try {
        await new Promise((r) => setTimeout(r, 1100)); // horodatage différent
        let text = await readFile(paths.config, "utf8");
        text = text.replace('time = "12:30"', 'time = "09:15"');
        const tmp = `${paths.config}.edit`;
        await writeFile(tmp, text);
        await rename(tmp, paths.config);
        const timeout = new Promise<string>((r) => setTimeout(() => r("timeout"), 4000));
        expect(await Promise.race([changed.then(() => "ok"), timeout])).toBe("ok"); // modification détectée
        expect((await store.load()).config.schedule.time).toBe("09:15");
      } finally {
        watcher.cancel();
      }
    });
  });

  test("keychain_roundtrip_without_secret_in_file", async () => {
    const { generic } = fakeKeychain();
    try {
      const service = `${KEYCHAIN_SERVICE_PREFIX}selftest-${crypto.randomUUID()}`;
      await setGenericPassword("s3cr3t-✓", service, "test");
      expect(await genericPassword(service, "test")).toBe("s3cr3t-✓");
      await setGenericPassword("autre", service, "test");
      expect(await genericPassword(service, "test")).toBe("autre");
      expect(generic.get(`${service}\0test`)?.label).toBe(`Cairn — ${service}`);
      const c = defaultConfig();
      c.destinations = [destination("nas", "smb", { url: "smb://nas/b", keychain: "nas" })];
      expect(newConfigDocument(c).render()).not.toContain("autre");
    } finally {
      setNative(null);
    }
  });

  test("mot de passe d'image : service par destination, compte = machine ; NAS : mot de passe Internet", async () => {
    const { generic, internet } = fakeKeychain();
    setMachineName("Mac-de-test");
    try {
      expect(imagePasswordService("main")).toBe("fr.lenzotti.cairn.image.main");
      expect(keychainLabel("fr.lenzotti.cairn.image.main")).toBe("Cairn — fr.lenzotti.cairn.image.main");
      expect(await imagePassword("main")).toBeNull();
      await setImagePassword("main", "pw");
      expect(generic.get("fr.lenzotti.cairn.image.main\0Mac-de-test")).toEqual({
        password: "pw",
        label: "Cairn — fr.lenzotti.cairn.image.main",
      });
      expect(await imagePassword("main")).toBe("pw");
      expect(await imagePassword("main", "Autre-Mac")).toBeNull();

      const nas = destination("nas", "smb", { url: "smb://nas.local/backups", username: "romain", keychain: "old" });
      expect(await smbPassword(nas)).toBeNull();
      expect(await setSmbPassword(nas, "secret")).toBe(true);
      expect(internet.get("nas.local\0romain\0smb")).toBe("secret");
      expect(await smbPassword(nas)).toBe("secret");
      // Sans `username` : l'utilisateur courant.
      internet.set(`nas.local\0${os.userInfo().username}\0smb`, "finder");
      expect(await smbPassword(destination("n2", "smb", { url: "smb://nas.local/x" }))).toBe("finder");
      expect(await setSmbPassword(destination("n3", "smb", { url: "pas une url" }), "x")).toBe(false);
    } finally {
      setMachineName(null);
      setNative(null);
    }
  });

  test("log_retention", async () => {
    await withTempDir(async (dir) => {
      const paths = new CairnPaths(dir);
      await paths.ensure();
      const now = new Date();
      const log = async (name: string, daysAgo: number) => {
        const file = path.join(paths.logs, name);
        await writeFile(file, "x");
        const when = new Date(now.getTime() - daysAgo * 86_400_000);
        await utimes(file, when, when);
      };
      await log("analyze-old.log", 120);
      await log("backup-kept.log", 200);
      await log("analyze-recent.log", 10);
      const removed = await pruneLogs(paths, 90, new Set(["backup-kept.log"]), now);
      expect(removed).toEqual(["analyze-old.log"]);
      expect(existsSync(path.join(paths.logs, "backup-kept.log"))).toBe(true);
      expect(existsSync(path.join(paths.logs, "analyze-recent.log"))).toBe(true);
    });
  });

  test("aller-retour du store sur une copie de ~/.cairn/config.toml : fichier inchangé", async () => {
    await withTempDir(async (dir) => {
      const copy = path.join(dir, "config.toml");
      let bytes: Buffer;
      try {
        bytes = await readFile(path.join(os.homedir(), ".cairn", "config.toml"));
      } catch {
        return; // pas de configuration sur cette machine
      }
      await writeFile(copy, bytes);
      const loaded = await ConfigStore.forConfigFile(copy).load();
      expect(loaded.migrated).toBe(false);
      expect(Buffer.from(loaded.document.render(), "utf8").equals(bytes)).toBe(true);
      expect((await readFile(copy)).equals(bytes)).toBe(true);
    });
  });
});
