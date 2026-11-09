// Avertissements et vérifications de la sauvegarde : port un à un de Cairn/Tests/CairnTests/BackupWarningTests.swift.
// Les cas purement CLI (cli_backup_unknown_tool, yes_is_accepted_everywhere, cli_config_json, cli_restore_json) sont
// portés avec la CLI ; retention_shortening_detection est dans retention.test.ts. Ici, leur partie moteur/service.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SparseImage } from "../../src/core/backup/image.ts";
import { stillDamaged, verifyVersion } from "../../src/core/backup/integrity.ts";
import { BackupService } from "../../src/core/backup/run.ts";
import { destinationState, loadRunState, saveRunState } from "../../src/core/backup/run-state.ts";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { VerifyError, verifyDestination } from "../../src/core/backup/verify.ts";
import { listVersions, versionsDir } from "../../src/core/backup/versions.ts";
import { OperationLock, OperationLockError } from "../../src/core/lock.ts";
import { CAIRN_VERSION } from "../../src/core/version.ts";
import {
  detachImagesUnder,
  TestClock,
  testConfig,
  testDeps,
  testPaths,
  withTempDir,
  writeFile,
} from "../helpers/backup-env.ts";
import { nativeAvailable } from "../helpers/native.ts";

const native = nativeAvailable();

/** Configuration de test : un dossier source et une destination locale non chiffrée. */
function setup(dir: string, files = 3) {
  const src = path.join(dir, "src");
  const dest = path.join(dir, "dest");
  for (let i = 0; i < files; i++) writeFile(path.join(src, `f${i}.bin`), 10_000 + i);
  const paths = testPaths(dir);
  const config = testConfig([src], [{ id: "local", path: dest }]);
  return { paths, src, dest, config };
}

/** Abîme un fichier d'une version sans changer sa taille ni sa date. */
function corrupt(file: string): void {
  const { size, atime, mtime } = statSync(file);
  writeFileSync(file, Buffer.alloc(size, 7));
  utimesSync(file, atime, mtime);
}

async function clearVerification(paths: ReturnType<typeof testPaths>): Promise<void> {
  const state = await loadRunState(paths);
  if (state.destinations.local) delete state.destinations.local.lastVerification;
  await saveRunState(paths, state);
}

describe.skipIf(!native)("backup-warning", () => {
  test("manifest_records_cairn_version", async () => {
    await withTempDir(async (dir) => {
      const { paths, dest, config } = setup(dir);
      const r = await new BackupService(paths, config, testDeps()).run();
      const v = r[0]!.outcome!.version!;
      const m = JSON.parse(readFileSync(path.join(versionsDir(dest, "m"), v, "manifest.json"), "utf8"));
      expect(m.cairn).toBe(CAIRN_VERSION);
      expect(CAIRN_VERSION).not.toBe("1");
      expect(CAIRN_VERSION.length).toBeGreaterThan(0);
    });
  });

  test("result_exposes_log_and_monthly_damage", async () => {
    await withTempDir(async (dir) => {
      const { paths, dest, config } = setup(dir);
      const versions = versionsDir(dest, "m");
      const clock = new TestClock(new Date());
      const deps = testDeps({ now: clock.now });
      const r1 = await new BackupService(paths, config, deps).run();
      expect(existsSync(r1[0]!.log!)).toBe(true); // le journal existe
      expect(r1[0]!.damagedFiles).toEqual([]);
      expect(r1[0]!.imageCheck).toBeNull(); // pas d'image sur une destination locale non chiffrée
      // Fichier abîmé dans v1 : v2 le reprend par lien physique ; la vérification mensuelle le trouve.
      corrupt(path.join(versions, r1[0]!.outcome!.version!, "folders/src/f1.bin"));
      await clearVerification(paths);
      clock.advance(2000);
      const r2 = await new BackupService(paths, config, deps).run();
      expect(r2[0]!.damagedFiles).toEqual(["folders/src/f1.bin"]);
      const v2 = r2[0]!.outcome!.version!;
      expect(destinationState(await loadRunState(paths), "local").damagedVersions).toEqual([v2]);
      // Sauvegarde suivante : le fichier est recopié depuis la source, l'état est vidé.
      clock.advance(2000);
      const r3 = await new BackupService(paths, config, deps).run();
      expect(r3[0]!.error).toBeNull();
      expect(destinationState(await loadRunState(paths), "local").damagedVersions).toEqual([]);
      const v3 = path.join(versions, r3[0]!.outcome!.version!);
      expect((await verifyVersion(v3, { full: true })).damaged).toEqual([]);
    });
  });

  test("still_damaged_keeps_unrepaired_versions_once", async () => {
    await withTempDir(async (dir) => {
      for (const v of ["2026-11-01T120000", "2026-11-02T120000"]) {
        mkdirSync(path.join(dir, v));
        writeFileSync(path.join(dir, v, "damaged.tsv"), "folders/a/x.bin\n");
      }
      const damaged = ["2026-11-01T120000", "2026-11-02T120000", "2026-11-02T120000", "2026-10-01T120000"];
      // Doublon et version supprimée retirés.
      expect(await stillDamaged(damaged, dir, {})).toEqual(["2026-11-01T120000", "2026-11-02T120000"]);
      expect(await stillDamaged(damaged, dir, { "folders/a": ["x.bin"] })).toEqual([]);
    });
  });

  test("cli_verify_writes_state_and_json", async () => {
    await withTempDir(async (dir) => {
      const { paths, dest, config } = setup(dir);
      const deps = testDeps();
      await new BackupService(paths, config, deps).run();
      const v = (await listVersions(versionsDir(dest, "m"))).at(-1)!;
      corrupt(path.join(versionsDir(dest, "m"), v, "folders/src/f0.bin"));
      await clearVerification(paths);
      const session = { secrets: deps.secrets, machine: "m" };
      const reports = await verifyDestination(config.destinations[0]!, paths, session, { full: true });
      expect(reports[0]!.version).toBe(v);
      expect(reports[0]!.damaged).toEqual(["folders/src/f0.bin"]);
      expect(reports[0]!.checked).toBeGreaterThanOrEqual(3);
      const ds = destinationState(await loadRunState(paths), "local");
      expect(ds.lastVerification).toBeDefined(); // la vérification est notée
      expect(ds.damagedVersions).toEqual([v]);
      // Deuxième passage : pas de doublon.
      await verifyDestination(config.destinations[0]!, paths, session, { full: true });
      expect(destinationState(await loadRunState(paths), "local").damagedVersions).toEqual([v]);
    });
  });

  test("cli_verify_unknown_version_is_usage_error", async () => {
    await withTempDir(async (dir) => {
      const { paths, config } = setup(dir);
      const deps = testDeps();
      await new BackupService(paths, config, deps).run();
      const error = await verifyDestination(
        config.destinations[0]!,
        paths,
        { secrets: deps.secrets, machine: "m" },
        { full: false, version: "1999-01-01T000000" },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VerifyError);
      expect((error as Error).message).toContain("1999-01-01T000000");
    });
  });

  test("cli_verify_refused_while_locked", async () => {
    await withTempDir(async (dir) => {
      const { paths, config } = setup(dir);
      const deps = testDeps();
      await new BackupService(paths, config, deps).run();
      const lock = new OperationLock({ stateDir: paths.state });
      await lock.acquire("backup");
      try {
        const error = await verifyDestination(
          config.destinations[0]!,
          paths,
          { secrets: deps.secrets, machine: "m" },
          { full: false },
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OperationLockError);
        expect((error as Error).message).toContain("already running");
      } finally {
        await lock.release();
      }
    });
  });

  test("sparse_image_verify", async () => {
    await withTempDir(async (dir) => {
      const secrets = new MemorySecrets();
      const img = SparseImage.forMachine(dir, "selftest", false, "m", { secrets });
      mkdirSync(path.join(dir, "e"));
      const enc = SparseImage.forMachine(path.join(dir, "e"), "selftest-e", true, "m", { secrets });
      try {
        await img.create("50m");
        const check = await img.verify();
        expect(check.ok).toBe(true);
        const pw = await enc.create("50m");
        expect((await enc.verify()).ok).toBe(true); // mot de passe rangé
        expect((await enc.verify(pw)).ok).toBe(true);
        expect((await enc.verify("wrong-password")).ok).toBe(false); // mauvais mot de passe : échec
        // Image abîmée : sa description a disparu.
        rmSync(path.join(img.path, "Info.plist"));
        rmSync(path.join(img.path, "Info.bckup"));
        expect((await img.verify()).ok).toBe(false);
      } finally {
        detachImagesUnder(dir);
      }
    });
  }, 60_000);

  test("encrypted_destination_monthly_check_verifies_image", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      writeFile(path.join(src, "a.bin"), 1000);
      mkdirSync(dest);
      const paths = testPaths(dir);
      const config = testConfig([src], [{ id: "selftest", path: dest, encrypted: true }]);
      try {
        const r = await new BackupService(paths, config, testDeps()).run({ only: ["folder"] });
        expect(r[0]!.error).toBeNull();
        expect(r[0]!.imageCheck?.ok).toBe(true);
        expect(r[0]!.newImagePassword).not.toBeNull(); // image neuve : mot de passe rendu une fois
        const ds = destinationState(await loadRunState(paths), "selftest");
        expect(ds.lastImageCheck).toBeDefined();
        expect(ds.lastImageCheckOK).toBe(true);
        expect(readFileSync(r[0]!.log!, "utf8")).toContain("image verify ok");
      } finally {
        detachImagesUnder(dir);
      }
    });
  }, 120_000);

  test("wait_until_finished_after_cancel", async () => {
    await withTempDir(async (dir) => {
      const { paths, config } = setup(dir, 50);
      const service = new BackupService(paths, config, testDeps());
      expect(await service.waitUntilFinished(100)).toBe(true); // rien en cours
      const done = service.run().catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      service.cancel();
      expect(await service.waitUntilFinished(20_000)).toBe(true); // la sauvegarde s'arrête
      expect(service.isRunning).toBe(false);
      // Le verrou est rendu : une autre opération peut le prendre.
      const lock = new OperationLock({ stateDir: paths.state });
      await lock.acquire("test");
      await lock.release();
      await done;
    });
  });
});
