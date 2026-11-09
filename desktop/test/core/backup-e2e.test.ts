// Sauvegarde de bout en bout (spec `backup` modifiée, « Sauvegarde complète de bout en bout ») et compatibilité avec
// la 0.8.0 : vraies commandes (rsync, hdiutil avec de petites images dans un dossier temporaire), home simulé,
// destinations temporaires. Le partage SMB est simulé par un montage existant (table des montages injectée) : tout le
// chemin SMB tourne (image toujours utilisée), sauf le montage NetFS lui-même.
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultBackupDependencies } from "../../src/core/backup/defaults.ts";
import { readChecksums, verifyVersion } from "../../src/core/backup/integrity.ts";
import type { DestinationProgress } from "../../src/core/backup/progress.ts";
import { BackupService } from "../../src/core/backup/run.ts";
import { destinationState, loadRunState } from "../../src/core/backup/run-state.ts";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { DestinationSession } from "../../src/core/backup/session.ts";
import { listVersions, versionsDir } from "../../src/core/backup/versions.ts";
import { type CairnConfig, defaultConfig, destination, folder } from "../../src/core/config.ts";
import { ConfigStore } from "../../src/core/config-store.ts";
import { machineName } from "../../src/core/machine.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { detachImagesUnder, TestClock, withTempDir, writeFile } from "../helpers/backup-env.ts";
import { nativeAvailable } from "../helpers/native.ts";

const exec = promisify(execFile);
const native = nativeAvailable();
const SWIFT_APP = path.join(os.homedir(), "Applications/Cairn.app/Contents/MacOS/Cairn");

/** Home simulé : quelques fichiers de configuration, un projet avec des dépendances régénérables. */
function simulatedHome(home: string): void {
  writeFile(path.join(home, ".zshrc"), 120);
  writeFile(path.join(home, ".config/app/settings.json"), 300);
  writeFile(path.join(home, ".config/app/cache/blob"), 5000); // exclu (cache/)
  for (let i = 0; i < 12; i++) writeFile(path.join(home, `projects/site/src/f${i}.ts`), 2000 + i);
  writeFile(path.join(home, "projects/site/package.json"), 50);
  writeFile(path.join(home, "projects/site/node_modules/dep/index.js"), 4000); // exclu (régénérable)
  writeFile(path.join(home, "projects/notes/todo.md"), 64);
  writeFile(path.join(home, "projects/README.md"), 10);
}

describe.skipIf(!native)("backup-e2e", () => {
  test("sauvegarde complète vers un dossier, une image chiffrée et un partage SMB, puis incrémentale avec liens physiques", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      simulatedHome(home);
      const paths = new CairnPaths(path.join(dir, ".cairn"));
      const config = defaultConfig();
      config.folders = [folder(path.join(home, "projects"))];
      config.home.include = [".zshrc", ".config/app"];
      config.destinations = [
        destination("disk", "local", { path: path.join(dir, "disk"), encrypted: false }),
        destination("vault", "local", { path: path.join(dir, "vault"), encrypted: true }),
        destination("nas", "smb", { url: "smb://nas.test/share/cairn", encrypted: false }),
      ];
      mkdirSync(path.join(dir, "vault"));
      const share = path.join(dir, "share");
      mkdirSync(path.join(share, "cairn"), { recursive: true });
      const secrets = new MemorySecrets();
      const clock = new TestClock(new Date());
      const deps = defaultBackupDependencies({
        home,
        machine: "e2e",
        secrets,
        imageSize: "200m",
        now: clock.now,
        progressThrottleMs: 0,
        reachable: async () => true,
        mountTable: async () => [{ from: "//me@nas.test/share", on: share, type: "smbfs" }],
        macos: async () => "Version 15.0 (Build 24A335)",
      });
      try {
        const service = new BackupService(paths, config, deps);
        const progress: DestinationProgress[] = [];
        service.on((e) => {
          if (e.type === "progress") progress.push(e.progress);
        });
        const first = await service.run();
        expect(first.map((r) => [r.destination, r.error])).toEqual([
          ["disk", null],
          ["vault", null],
          ["nas", null],
        ]);
        // Chaque destination passe par toutes les phases jusqu'à « terminé ».
        for (const id of ["disk", "vault", "nas"]) {
          const seq: string[] = [];
          for (const p of progress) if (p.destination === id && seq.at(-1) !== p.phase) seq.push(p.phase);
          for (const phase of ["preparing", "counting", "copying", "finishing", "done"]) expect(seq).toContain(phase);
          expect(seq.at(-1)).toBe("done");
        }
        // Mot de passe de l'image neuve rendu une fois, rangé (ici dans le Trousseau en mémoire).
        expect(first[1]!.newImagePassword).toMatch(/^[A-Za-z2-9]{6}(-[A-Za-z2-9]{6}){3}$/);
        expect(await secrets.imagePassword("vault", "e2e")).toBe(first[1]!.newImagePassword);
        expect(first[0]!.newImagePassword).toBeNull();
        // Journal sans erreur.
        const log = readFileSync(first[0]!.log!, "utf8");
        expect(log).not.toMatch(/error/i);
        expect(log).toContain("parts: folders/projects, home, tools");
        for (const id of ["disk", "vault", "nas"]) expect(log).toContain(`${id}: version `);
        const state = await loadRunState(paths);
        for (const id of ["disk", "vault", "nas"]) {
          const ds = destinationState(state, id);
          expect(ds.lastSuccess).toBeDefined();
          expect(ds.lastError).toBeUndefined();
          expect(ds.fileCounts).toEqual({ "folders/projects": 15, home: 2, tools: 2 });
        }
        expect(destinationState(state, "vault").lastImageCheckOK).toBe(true);

        // Seconde sauvegarde, le lendemain : incrémentale, liens physiques vers la première.
        clock.advance(86_400_000);
        writeFile(path.join(home, "projects/notes/new.md"), 33);
        const second = await new BackupService(paths, config, deps).run();
        expect(second.map((r) => r.error)).toEqual([null, null, null]);
        for (const r of second) {
          expect(r.outcome!.filesTransferred).toBeLessThanOrEqual(3); // new.md (+ inventaire régénéré)
          expect(r.outcome!.bytesByPart["folders/projects"]).toBe(33);
        }
        expect(readFileSync(second[0]!.log!, "utf8")).not.toMatch(/error/i);

        const check = async (root: string) => {
          const dir = versionsDir(root, "e2e");
          const versions = await listVersions(dir);
          expect(versions).toHaveLength(2);
          const [v1, v2] = versions as [string, string];
          expect(path.basename(await realLatest(dir))).toBe(v2);
          const rel = "folders/projects/site/src/f3.ts";
          expect(statSync(path.join(dir, v1, rel)).ino).toBe(statSync(path.join(dir, v2, rel)).ino);
          expect(existsSync(path.join(dir, v2, "folders/projects/site/node_modules"))).toBe(false);
          expect(existsSync(path.join(dir, v2, "home/.config/app/cache"))).toBe(false);
          expect(existsSync(path.join(dir, v2, "tools/tools.toml"))).toBe(true);
          const sums = await readChecksums(path.join(dir, v2));
          expect(sums.has("folders/projects/notes/new.md")).toBe(true);
          expect((await verifyVersion(path.join(dir, v2), { full: true })).damaged).toEqual([]);
        };
        await check(path.join(dir, "disk"));
        for (const d of config.destinations.slice(1)) {
          const session = new DestinationSession(d, { ...deps, secrets, machine: "e2e" });
          const root = await session.open(false);
          try {
            await check(root);
          } finally {
            await session.close();
          }
        }
        expect(existsSync(path.join(share, "cairn/cairn-e2e.sparsebundle"))).toBe(true); // SMB : toujours une image
      } finally {
        detachImagesUnder(dir);
      }
    });
  }, 180_000);

  describe.skipIf(!existsSync(SWIFT_APP))("compatibilité avec la 0.8.0", () => {
    async function swift(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
      try {
        const r = await exec(SWIFT_APP, [...args, "--lang", "en-US"], { timeout: 120_000, maxBuffer: 16 << 20 });
        return { code: 0, stdout: r.stdout, stderr: r.stderr };
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    }

    test("une version écrite ici est relue par la 0.8.0 (restore --from en simulation, verify) ; runs.json survit", async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        for (let i = 0; i < 6; i++) writeFile(path.join(src, `d${i % 2}/f${i}.bin`), 1000 + i);
        const dest = path.join(dir, "dest");
        const cfgDir = path.join(dir, "cfg");
        mkdirSync(cfgDir);
        const config: CairnConfig = defaultConfig();
        config.folders = [folder(src)];
        config.destinations = [destination("local", "local", { path: dest, encrypted: false })];
        const store = ConfigStore.forConfigFile(path.join(cfgDir, "config.toml"));
        await store.save(config);
        // Même nom de machine que la 0.8.0 (scutil) : elle cherche les versions de ce Mac.
        const machine = await machineName();
        const deps = defaultBackupDependencies({
          home: path.join(dir, "no-home"),
          machine,
          secrets: new MemorySecrets(),
        });
        const r = await new BackupService(store.paths, config, deps).run({ only: ["folder", "tools"] });
        expect(r[0]!.error).toBeNull();
        const version = path.join(versionsDir(dest, machine), r[0]!.outcome!.version!);

        // restore --from : simulation (sans --apply), parties et tailles relues dans le manifest.
        const restore = await swift(["--config", store.file, "restore", "--from", version, "--json"]);
        expect(restore.code).toBe(0);
        const plan = JSON.parse(restore.stdout);
        expect(plan.apply).toBe(false);
        expect(plan.source.kind).toBe("cairn");
        expect(typeof plan.source.date).toBe("string");
        expect(plan.bytes_by_part["folders/src"]).toBeGreaterThan(0);
        // verify --full : la 0.8.0 relit checksums.tsv (aucun fichier abîmé) et réécrit runs.json.
        const verify = await swift(["--config", store.file, "verify", "--full", "--json"]);
        expect(verify.code).toBe(0);
        const report = JSON.parse(verify.stdout);
        expect(report.results[0].damaged).toEqual([]);
        expect(report.results[0].checked).toBe(6 + 2);
        // Si la 0.8.0 n'avait pas su décoder runs.json, elle aurait réécrit un état vide (sans lastSuccess).
        const ds = destinationState(await loadRunState(store.paths), "local");
        expect(ds.lastSuccess).toBeDefined();
        expect(ds.lastVerification).toBeDefined();
        expect(ds.fileCounts).toEqual({ "folders/src": 6, tools: 2 });
        expect(ds.keptLogs).toHaveLength(1);
      });
    }, 180_000);

    test("une version de la 0.8.0 sert de base ici : liens physiques et empreintes reprises", async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        for (let i = 0; i < 6; i++) writeFile(path.join(src, `d${i % 2}/f${i}.bin`), 2000 + i);
        const dest = path.join(dir, "dest");
        const cfgDir = path.join(dir, "cfg");
        mkdirSync(cfgDir);
        const config = defaultConfig();
        config.folders = [folder(src)];
        config.destinations = [destination("local", "local", { path: dest, encrypted: false })];
        const store = ConfigStore.forConfigFile(path.join(cfgDir, "config.toml"));
        await store.save(config);
        const backup = await swift(["--config", store.file, "backup", "--only", "folders"]);
        expect(backup.code).toBe(0);
        const machine = await machineName();
        const dir08 = versionsDir(dest, machine);
        const [swiftVersion] = await listVersions(dir08);
        expect(swiftVersion).toBeDefined();
        // État écrit par la 0.8.0 : relu (total attendu de la progression).
        expect(destinationState(await loadRunState(store.paths), "local").fileCounts).toEqual({ "folders/src": 6 });
        await new Promise((r) => setTimeout(r, 1100)); // autre nom de version
        const deps = defaultBackupDependencies({
          home: path.join(dir, "no-home"),
          machine,
          secrets: new MemorySecrets(),
        });
        const r = await new BackupService(store.paths, config, deps).run({ only: ["folder"] });
        expect(r[0]!.error).toBeNull();
        expect(r[0]!.outcome!.filesTransferred).toBe(0);
        const v2 = r[0]!.outcome!.version!;
        const rel = "folders/src/d0/f0.bin";
        expect(statSync(path.join(dir08, swiftVersion!, rel)).ino).toBe(statSync(path.join(dir08, v2, rel)).ino);
        const a = await readChecksums(path.join(dir08, swiftVersion!));
        const b = await readChecksums(path.join(dir08, v2));
        expect(b.get(rel)).toEqual(a.get(rel)!); // empreinte de la 0.8.0 reprise telle quelle
        expect(readFileSync(path.join(dir08, swiftVersion!, "checksums.tsv"), "utf8")).toBe(
          readFileSync(path.join(dir08, v2, "checksums.tsv"), "utf8"),
        );
      });
    }, 180_000);
  });
});

async function realLatest(dir: string): Promise<string> {
  const { readlink } = await import("node:fs/promises");
  return readlink(path.join(dir, "latest"));
}
