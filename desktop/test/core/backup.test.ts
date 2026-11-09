// Moteur et service de sauvegarde : port un à un de Cairn/Tests/CairnTests/BackupTests.swift.
// Hors périmètre ici (portés par leur domaine) : tiered_retention (retention.test.ts), schedule_decisions et
// overdue_notification (schedule.test.ts) ; le 593f593 (mémoire du hachage) est dans test/regressions/backup.test.ts.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { countFiles } from "../../src/core/backup/count.ts";
import { BackupEngine, excessVersions } from "../../src/core/backup/engine.ts";
import { attachFailure, SparseImage } from "../../src/core/backup/image.ts";
import { readChecksums, recopyPlanFrom, verifyVersion } from "../../src/core/backup/integrity.ts";
import { type DestinationProgress, DestinationTracker } from "../../src/core/backup/progress.ts";
import { copyChunks, detectRsync } from "../../src/core/backup/rsync.ts";
import { BackupService } from "../../src/core/backup/run.ts";
import { destinationState, keptLogs, loadRunState } from "../../src/core/backup/run-state.ts";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { DestinationSession } from "../../src/core/backup/session.ts";
import { BackupError, backupPart, ProviderError } from "../../src/core/backup/types.ts";
import { verifyDestination } from "../../src/core/backup/verify.ts";
import {
  INCOMPLETE_PREFIX,
  isPartial,
  listVersions,
  versionLogs,
  versionName,
  versionsDir,
} from "../../src/core/backup/versions.ts";
import { RECOMMENDED_RETENTION } from "../../src/core/config.ts";
import { pruneLogs } from "../../src/core/config-logs.ts";
import { isLockHeld, OperationLock, OperationLockError } from "../../src/core/lock.ts";
import { keepVersions } from "../../src/core/retention.ts";
import {
  at,
  detachImagesUnder,
  du,
  TestClock,
  testConfig,
  testDeps,
  testPaths,
  withTempDir,
  writeFile,
} from "../helpers/backup-env.ts";
import { nativeAvailable } from "../helpers/native.ts";

const native = nativeAvailable();
const engine = () => new BackupEngine({ retentionKeep: keepVersions, macos: async () => "Version 15.0" });
const rec = RECOMMENDED_RETENTION;

/** Version interrompue récente (reprise par la prochaine sauvegarde), pour la machine « m ». */
function incompleteVersion(dest: string): string {
  const work = path.join(versionsDir(dest, "m"), INCOMPLETE_PREFIX + versionName(new Date(Date.now() - 60_000)));
  mkdirSync(work, { recursive: true });
  return work;
}

function gitInit(dir: string): void {
  execFileSync("/usr/bin/git", ["-C", dir, "init", "-q"]);
}

describe("backup", () => {
  test("image_locked_by_stuck_helper_is_explained", () => {
    const p = "/Volumes/home/cairn/cairn-mac.sparsebundle";
    const busy = attachFailure("hdiutil: attach failed - Resource temporarily unavailable", p);
    expect(busy.reason).toBe("imageBusy");
    expect(busy.subject).toBe(p);
    expect(busy.message).toContain("cairn-mac.sparsebundle");
    expect(attachFailure("hdiutil: attach failed - Ressources temporairement indisponibles", p).reason).toBe(
      "imageBusy",
    );
    const other = attachFailure("hdiutil: attach failed - Authentication error\n", p);
    expect(other.reason).toBe("image");
    expect(other.subject).toBe("hdiutil: attach failed - Authentication error");
  });

  test("exclusions_follow_gitignore_and_markers", async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, "repo");
      writeFile(path.join(repo, "lib/versioned.js"), 10);
      writeFile(path.join(repo, "build/out.js"), 10);
      writeFileSync(path.join(repo, ".gitignore"), "build/\n");
      gitInit(repo);
      writeFile(path.join(dir, "plain/lib/x.js"), 10); // pas de package.json : gardé
      writeFile(path.join(dir, "node/package.json"), 10);
      writeFile(path.join(dir, "node/out/y.js"), 10);
      const list = await testDeps().regenerable.forFolder(dir, {
        userPatterns: ["*.iso"],
        destinations: [`${dir}/backups`],
        isCancelled: () => false,
        onDir: () => {},
      });
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

  test("home_selection_excludes_ai_dirs_and_caches", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      for (const f of [
        ".zshrc",
        ".claude/settings.json",
        ".codex/config.toml",
        ".config/gcloud/creds.json",
        ".config/gcloud/logs/a.log",
        ".config/gcloud/cache/x",
      ]) {
        writeFile(path.join(home, f), 100);
      }
      const rules = testDeps().regenerable;
      const items = await rules.homeItems([".zshrc", ".claude", ".codex", ".config/gcloud", ".absent"], home);
      expect(items).toEqual([".zshrc", ".config/gcloud"]);
      const dest = path.join(dir, "dest");
      await engine().run({
        parts: [backupPart("home", "home", home, { excludes: [...rules.homeExcludes], filesFrom: items })],
        root: dest,
        retention: rec,
        dryRun: false,
        machine: "test",
      });
      const v = path.join(versionsDir(dest, "test"), "latest/home");
      expect(existsSync(path.join(v, ".zshrc"))).toBe(true);
      expect(existsSync(path.join(v, ".config/gcloud/creds.json"))).toBe(true);
      expect(existsSync(path.join(v, ".config/gcloud/logs"))).toBe(false); // journaux exclus
      expect(existsSync(path.join(v, ".config/gcloud/cache"))).toBe(false); // cache exclu
      expect(existsSync(path.join(v, ".claude"))).toBe(false); // dossiers IA hors du home
    });
  });

  test("second_version_is_hard_linked", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      for (let i = 0; i < 20; i++) writeFile(path.join(src, `f${i}.bin`), 100_000);
      const part = backupPart("folder", "folders/src", src);
      const e = engine();
      const params = { parts: [part], root: dest, retention: rec, dryRun: false, machine: "m" };
      const v1 = await e.run({ ...params, now: at("2026-11-01T120000") });
      const v2 = await e.run({ ...params, now: at("2026-11-02T120000") });
      expect(v1.filesTransferred).toBe(20);
      expect(v2.filesTransferred).toBe(0);
      const versions = versionsDir(dest, "m");
      expect(await listVersions(versions)).toHaveLength(2);
      expect(du(versions)).toBeLessThan(2_600_000); // la 2e version doit être liée
      const manifest = JSON.parse(readFileSync(path.join(versions, "latest/manifest.json"), "utf8"));
      expect(manifest.machine).toBe("m");
      expect(statSync(path.join(versions, v1.version!, "folders/src/f0.bin")).ino).toBe(
        statSync(path.join(versions, v2.version!, "folders/src/f0.bin")).ino,
      );
    });
  });

  test("progress_reaches_the_expected_total", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      for (let i = 0; i < 30; i++) writeFile(path.join(src, `d${i % 3}/f${i}.bin`), 1000);
      const part = backupPart("folder", "folders/src", src);
      const params = { parts: [part], root: dest, retention: rec, dryRun: false, machine: "m" };
      const first: DestinationProgress[] = [];
      const v1 = await engine().run(
        { ...params, now: at("2026-11-01T120000") },
        new DestinationTracker("d", false, (p) => first.push(p), { throttleMs: 0 }),
      );
      // Première sauvegarde : comptage pendant la copie ; 30 fichiers examinés, retenus pour la suivante.
      expect(first.findLast((p) => !p.finishing)?.copy?.processed).toBe(30);
      expect(v1.filesByPart["folders/src"]).toBe(30);
      expect(first.every((p) => (p.copy?.percent ?? 0) <= 99)).toBe(true); // plafonné à 99 %
      // Suivante : le décompte précédent sert d'estimation dès le début ; les compteurs restent visibles pendant le
      // nouveau comptage (spec modifiée : la 0.8.0 ne comptait plus et cachait les compteurs).
      const next: DestinationProgress[] = [];
      const v2 = await engine().run(
        { ...params, now: at("2026-11-02T120000"), expectedFiles: v1.filesByPart },
        new DestinationTracker("d", false, (p) => next.push(p), { throttleMs: 0 }),
      );
      expect(next.some((p) => p.phase === "counting" && p.counting?.knownTotal === 30)).toBe(true);
      expect(next.filter((p) => p.copy && !p.finishing).every((p) => p.copy!.expected === 30)).toBe(true);
      // Après la copie : empreintes des nouveaux fichiers annoncées, avec leur avancement.
      expect(first.some((p) => p.finishing?.some((s) => s.id === "checksums" && s.total === 30))).toBe(true);
      expect(next.findLast((p) => !p.finishing)?.copy?.processed).toBe(30);
      expect(v2.filesTransferred).toBe(0);
    });
  });

  test("parallel_count_matches_a_single_rsync", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      for (let i = 0; i < 40; i++) writeFile(path.join(src, `p${i % 7}/sub/f${i}.txt`), 10);
      for (let i = 0; i < 5; i++) writeFile(path.join(src, `p${i}/node_modules/x${i}.js`), 10);
      writeFile(path.join(src, "top.txt"), 10);
      writeFile(path.join(src, ".hidden"), 10);
      const part = backupPart("folder", "folders/src", src, { excludes: ["node_modules/"] });
      const binary = await detectRsync();
      // Pile : p0…p6 puis les fichiers du premier niveau, partagés entre 4 compteurs.
      expect(await copyChunks(part)).toHaveLength(8);
      const seen = new Set<string>();
      const finished = new Set<number>();
      let streamed = 0;
      const parallel = await countFiles(part, {
        binary,
        workers: 4,
        onWorker: (i, w) => {
          if (w.folder) seen.add(w.folder);
          if (w.done) finished.add(i);
        },
        onFound: (d) => {
          streamed += d;
        },
      });
      // Chaque dossier pris une fois dans la pile, les 4 compteurs terminent.
      expect(seen).toEqual(new Set(Array.from({ length: 7 }, (_, i) => `p${i}`)));
      expect(finished).toEqual(new Set([0, 1, 2, 3]));
      const single = await countFiles(part, { binary, workers: 1 });
      // 40 fichiers + top.txt + .hidden ; node_modules exclu dans chaque compteur.
      expect(single).toBe(42);
      expect(parallel).toBe(42);
      expect(streamed).toBe(42);
    });
  });

  test.skipIf(!native)("operation_lock_is_seen_from_outside", async () => {
    await withTempDir(async (dir) => {
      const stateDir = path.join(dir, "state");
      expect(await isLockHeld(path.join(stateDir, "operation.lock"))).toBe(false); // pas de fichier, pas de verrou
      const lock = new OperationLock({ stateDir });
      await lock.acquire("backup");
      expect(await OperationLock.isHeld({ stateDir })).toBe(true);
      await lock.release();
      expect(await OperationLock.isHeld({ stateDir })).toBe(false);
    });
  });

  test("rsync_errors_are_kept_in_the_warning", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "ok.bin"), 10);
      const locked = path.join(src, "locked.bin");
      writeFile(locked, 10);
      chmodSync(locked, 0);
      try {
        const r = await engine().run({
          parts: [backupPart("folder", "folders/src", src)],
          root: path.join(dir, "dest"),
          retention: rec,
          dryRun: false,
          machine: "m",
        });
        // Fichier illisible : code 23 (avertissement), avec la ligne d'erreur de rsync qui nomme le fichier.
        expect(r.warnings.some((w) => w.includes("locked.bin") && w.includes("Permission denied"))).toBe(true);
      } finally {
        chmodSync(locked, 0o600);
      }
    });
  });

  test("folder_is_copied_one_top_level_entry_at_a_time", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      for (const name of ["alpha", "beta", "gamma"]) {
        writeFile(path.join(src, `${name}/a.txt`), 10);
        writeFile(path.join(src, `${name}/node_modules/x.js`), 10);
      }
      writeFile(path.join(src, "top.txt"), 10);
      const part = backupPart("folder", "folders/src", src, { excludes: ["node_modules/"] });
      // Trois dossiers puis les fichiers du premier niveau.
      expect((await copyChunks(part)).map((c) => c.label)).toEqual(["alpha", "beta", "gamma", null]);
      const listing = new Set<string>();
      const v1 = await engine().run(
        { parts: [part], root: dest, retention: rec, dryRun: false, machine: "m", now: at("2026-11-01T120000") },
        new DestinationTracker(
          "d",
          false,
          (p) => {
            if (p.copy?.listing && p.copy.folderName) listing.add(p.copy.folderName);
          },
          { throttleMs: 0 },
        ),
      );
      expect(v1.filesTransferred).toBe(4);
      for (const n of ["alpha", "beta", "gamma"]) expect(listing.has(n)).toBe(true); // dossier en cours annoncé
      const latest = path.join(versionsDir(dest, "m"), "latest/folders/src");
      // Chaque morceau garde les autres (pas de --delete-excluded) et les exclusions s'appliquent partout.
      for (const n of ["alpha", "beta", "gamma"]) {
        expect(existsSync(path.join(latest, `${n}/a.txt`))).toBe(true);
        expect(existsSync(path.join(latest, `${n}/node_modules`))).toBe(false);
      }
      expect(existsSync(path.join(latest, "top.txt"))).toBe(true);
    });
  });

  test("resumed_chunked_copy_removes_excluded_and_vanished_entries", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      writeFile(path.join(src, "a/f.txt"), 10);
      writeFile(path.join(src, "a/node_modules/m.js"), 10);
      writeFile(path.join(src, "b/g.txt"), 10);
      // Version interrompue : un dossier depuis exclu, un dossier disparu de la source, un fichier déjà copié.
      const work = incompleteVersion(dest);
      for (const f of ["a/f.txt", "a/node_modules/old.js", "gone/z.txt"])
        writeFile(path.join(work, "folders/src", f), 10);
      const r = await engine().run({
        parts: [backupPart("folder", "folders/src", src, { excludes: ["node_modules/"] })],
        root: dest,
        retention: rec,
        dryRun: false,
        machine: "m",
      });
      const v = path.join(versionsDir(dest, "m"), r.version!, "folders/src");
      expect(existsSync(path.join(v, "a/f.txt"))).toBe(true); // fichier gardé
      expect(existsSync(path.join(v, "b/g.txt"))).toBe(true); // fichier copié
      expect(existsSync(path.join(v, "a/node_modules"))).toBe(false); // exclu retiré à la reprise
      expect(existsSync(path.join(v, "gone"))).toBe(false); // dossier disparu retiré
      // Total jamais sous-estimé : le comptage complet, sinon rien (l'ancien total est gardé).
      const n = r.filesByPart["folders/src"];
      expect(n === undefined || n === 2).toBe(true);
    });
  });

  test("failed_chunk_never_triggers_the_cleanup", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      writeFile(path.join(src, "a/f.txt"), 10);
      const locked = path.join(src, "b");
      writeFile(path.join(locked, "g.txt"), 10);
      const work = incompleteVersion(dest);
      writeFile(path.join(work, "folders/src/gone/z.txt"), 10);
      // Dossier illisible : rsync finit en 23, la passe de nettoyage ne doit pas tourner.
      chmodSync(locked, 0);
      try {
        const c = await engine().copy({
          parts: [backupPart("folder", "folders/src", src)],
          root: dest,
          retention: rec,
          dryRun: false,
          machine: "m",
        });
        expect(c.warnings.length).toBeGreaterThan(0); // transfert partiel signalé
        expect(existsSync(path.join(work, "folders/src/gone/z.txt"))).toBe(true); // rien d'effacé après un échec
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  });

  test("dry_run_writes_nothing", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      writeFile(path.join(src, "a.bin"), 300_000);
      const r = await engine().run({
        parts: [backupPart("folder", "folders/src", src)],
        root: dest,
        retention: rec,
        dryRun: true,
        machine: "m",
      });
      expect(r.bytesTransferred).toBe(300_000);
      const versions = versionsDir(dest, "m");
      expect(await listVersions(versions)).toHaveLength(0);
      expect(existsSync(versions) ? readdirSync(versions) : []).toEqual([]);
    });
  });

  test("cancelled_run_leaves_no_visible_version", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 1000);
      const e = engine();
      e.cancel();
      const error = await e
        .run({
          parts: [backupPart("folder", "folders/src", src)],
          root: path.join(dir, "dest"),
          retention: rec,
          dryRun: false,
          machine: "m",
        })
        .catch((x: unknown) => x);
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).reason).toBe("cancelled");
      expect(await listVersions(versionsDir(path.join(dir, "dest"), "m"))).toHaveLength(0);
    });
  });

  test("interrupted_backup_resumes_without_recopy", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      for (let i = 0; i < 10; i++) writeFile(path.join(src, `f${i}.bin`), 50_000);
      // Version interrompue récente : la moitié des fichiers déjà copiés.
      const incomplete = path.join(versionsDir(dest, "m"), `${INCOMPLETE_PREFIX}2026-11-08T110000/folders/src`);
      mkdirSync(incomplete, { recursive: true });
      for (let i = 0; i < 5; i++)
        cpSync(path.join(src, `f${i}.bin`), path.join(incomplete, `f${i}.bin`), { preserveTimestamps: true });
      const r = await engine().run({
        parts: [backupPart("folder", "folders/src", src)],
        root: dest,
        retention: rec,
        dryRun: false,
        machine: "m",
        now: at("2026-11-08T120000"),
      });
      expect(r.filesTransferred).toBe(5); // seuls les fichiers restants sont transférés
      expect(r.version).toBe("2026-11-08T110000");
    });
  });

  test("reduced_retention_lists_excess_without_deleting", async () => {
    await withTempDir(async (dir) => {
      const versions = path.join(dir, "v");
      for (let i = 1; i <= 20; i++)
        mkdirSync(path.join(versions, `2026-10-${String(i).padStart(2, "0")}T120000`), { recursive: true });
      const excess = await excessVersions(
        versions,
        { mode: "count", count: 12 },
        at("2026-11-08T120000"),
        keepVersions,
      );
      expect(excess).toHaveLength(8);
      expect(await listVersions(versions)).toHaveLength(20); // rien n'est supprimé avant confirmation
    });
  });

  test("integrity_detects_damage_and_next_backup_recopies", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      for (let i = 0; i < 5; i++) writeFile(path.join(src, `f${i}.bin`), 20_000);
      const part = backupPart("folder", "folders/src", src);
      const e = engine();
      const params = { parts: [part], root: dest, retention: rec, dryRun: false, machine: "m" };
      const v1 = await e.run({ ...params, now: at("2026-11-01T120000") });
      const versions = versionsDir(dest, "m");
      const vdir = path.join(versions, v1.version!);
      // Corruption : contenu modifié sans changer taille ni date.
      const damagedFile = path.join(vdir, "folders/src/f2.bin");
      const { mtime, atime } = statSync(damagedFile);
      writeFileSync(damagedFile, Buffer.alloc(20_000, 7));
      utimesSync(damagedFile, atime, mtime);
      const report = await verifyVersion(vdir, { full: true });
      expect(report.damaged).toEqual(["folders/src/f2.bin"]);
      const plan = await recopyPlanFrom(vdir, [part]);
      expect(plan["folders/src"]).toEqual(["f2.bin"]);
      const v2 = await e.run({ ...params, now: at("2026-11-02T120000"), forceRecopy: plan });
      const fresh = path.join(versions, v2.version!, "folders/src/f2.bin");
      expect(readFileSync(fresh).equals(Buffer.alloc(20_000))).toBe(true); // recopié depuis la source
      expect((await verifyVersion(path.join(versions, v2.version!), { full: true })).damaged).toEqual([]);
    });
  });

  test("encrypted_sparse_image_roundtrip", async () => {
    await withTempDir(async (dir) => {
      const secrets = new MemorySecrets();
      const img = SparseImage.forMachine(dir, "selftest", true, "m", { secrets });
      try {
        const pw = await img.create("100m");
        expect(pw).not.toBeNull();
        expect(await img.password()).toBe(pw); // mot de passe rangé
        const mp = await img.attach();
        writeFileSync(path.join(mp, "a.txt"), "secret");
        await img.detach();
        // Le contenu ne doit pas apparaître en clair dans l'image.
        let found = "";
        try {
          found = execFileSync("/usr/bin/grep", ["-r", "-l", "secret", img.path], { encoding: "utf8" });
        } catch {
          found = "";
        }
        expect(found).toBe("");
        const again = await img.attach();
        expect(readFileSync(path.join(again, "a.txt"), "utf8")).toBe("secret");
        await img.detach();
      } finally {
        await img.detach();
        detachImagesUnder(dir);
      }
    });
  }, 60_000);

  test("new_image_reuses_keychain_password_after_relocation", async () => {
    // Destination déplacée vers un dossier vide : la nouvelle image reprend le mot de passe rangé, qui ouvre toujours
    // l'image laissée à l'ancien emplacement.
    await withTempDir(async (dir) => {
      const secrets = new MemorySecrets();
      mkdirSync(path.join(dir, "ancien"));
      mkdirSync(path.join(dir, "nouveau"));
      const old = SparseImage.forMachine(path.join(dir, "ancien"), "selftest", true, "m", { secrets });
      try {
        const pw = await old.create("50m");
        const moved = SparseImage.forMachine(path.join(dir, "nouveau"), "selftest", true, "m", { secrets });
        expect(await moved.create("50m")).toBe(pw); // le mot de passe existant est repris
        expect(await moved.password()).toBe(pw);
        await old.attach();
        await old.detach();
      } finally {
        detachImagesUnder(dir);
      }
    });
  }, 60_000);

  test.skipIf(!native)("cli_backup_refused_while_locked_and_dry_run_is_safe", async () => {
    // Niveau service (la commande `cairn backup` est portée avec la CLI) : simulation sans `latest`, refus pendant
    // une autre opération, sauvegarde réelle, puis vérification complète.
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      writeFile(path.join(src, "a.bin"), 100_000);
      const paths = testPaths(dir);
      const config = testConfig([src], [{ id: "local", path: dest }]);
      const deps = testDeps();
      await new BackupService(paths, config, deps).run({ dryRun: true, only: ["folder"] });
      expect(existsSync(path.join(versionsDir(dest, "m"), "latest"))).toBe(false);
      const lock = new OperationLock({ stateDir: paths.state });
      await lock.acquire("app backup");
      const busy = await new BackupService(paths, config, deps).run({ only: ["folder"] }).catch((e: unknown) => e);
      expect(busy).toBeInstanceOf(OperationLockError);
      expect((busy as OperationLockError).message).toContain("already running");
      await lock.release();
      const ok = await new BackupService(paths, config, deps).run({ only: ["folder"] });
      expect(ok[0]?.error).toBeNull();
      const reports = await verifyDestination(
        config.destinations[0]!,
        paths,
        { secrets: deps.secrets, machine: "m" },
        { full: true },
      );
      expect(reports.every((r) => r.damaged.length === 0 && !r.missingChecksums)).toBe(true);
    });
  });

  test.skipIf(!native)(
    "dry_run_creates_nothing_on_destination",
    async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        writeFile(path.join(src, "a.bin"), 50_000);
        const paths = testPaths(dir);
        for (const [name, encrypted] of [
          ["plain", false],
          ["image", true],
        ] as const) {
          const dest = path.join(dir, `dest-${name}`);
          const config = testConfig([src], [{ id: `d-${name}`, path: dest, encrypted }]);
          // Destination absente : rien n'est créé, la simulation annonce tout ce qui serait copié.
          const r1 = await new BackupService(paths, config, testDeps()).run({ dryRun: true, only: ["folder"] });
          expect(r1[0]?.error).toBeNull();
          expect(Object.values(r1[0]!.outcome!.bytesByPart).reduce((a, b) => a + b, 0)).toBe(50_000);
          expect(existsSync(dest)).toBe(false);
          // Dossier vide : ni image, ni dossier des versions.
          mkdirSync(dest);
          const r2 = await new BackupService(paths, config, testDeps()).run({ dryRun: true, only: ["folder"] });
          expect(r2[0]?.error).toBeNull();
          expect(readdirSync(dest)).toEqual([]);
        }
      });
    },
    30_000,
  );

  test.skipIf(!native)(
    "next_destination_copies_while_the_previous_one_finishes",
    async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        // Un gros fichier : ses empreintes (finalisation de « a ») laissent le temps de voir la copie vers « b » partir.
        writeFile(path.join(src, "big.bin"), 150_000_000);
        writeFile(path.join(src, "small.txt"), 10);
        const paths = testPaths(dir);
        const config = testConfig(
          [src],
          ["a", "b"].map((id) => ({ id, path: path.join(dir, `dest-${id}`) })),
        );
        const service = new BackupService(paths, config, testDeps());
        const events: DestinationProgress[] = [];
        service.on((e) => {
          if (e.type === "progress") events.push(e.progress);
        });
        const r = await service.run({ only: ["folder"] });
        expect(r.map((x) => x.destination)).toEqual(["a", "b"]);
        expect(r.map((x) => x.error)).toEqual([null, null]);
        // Chaque destination annonce sa fin ; la copie vers « b » commence avant la fin de « a ».
        const aDone = events.findIndex((p) => p.destination === "a" && p.phase === "done");
        const bCopy = events.findIndex((p) => p.destination === "b" && p.copy !== null && !p.finishing);
        expect(aDone).toBeGreaterThan(-1);
        expect(events.some((p) => p.destination === "b" && p.phase === "done")).toBe(true);
        expect(bCopy).toBeGreaterThan(-1);
        expect(bCopy).toBeLessThan(aDone);
        const state = await loadRunState(paths);
        expect(destinationState(state, "a").lastSuccess).toBeDefined();
        expect(destinationState(state, "b").lastSuccess).toBeDefined();
      });
    },
    60_000,
  );

  test.skipIf(!native)(
    "stop_one_destination_keeps_the_others",
    async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        for (let i = 0; i < 20; i++) writeFile(path.join(src, `f${i}.bin`), 5_000_000);
        const paths = testPaths(dir);
        const config = testConfig(
          [src],
          ["a", "b"].map((id) => ({ id, path: path.join(dir, `dest-${id}`) })),
        );
        const service = new BackupService(paths, config, testDeps());
        // « Arrêter » sur « a » dès le début de sa copie : « b » est sauvegardée quand même.
        service.on((e) => {
          if (e.type === "progress" && e.progress.destination === "a" && e.progress.copy)
            service.cancelDestination("a");
        });
        const r = await service.run({ only: ["folder"] });
        expect(r.map((x) => x.destination)).toEqual(["a", "b"]);
        expect(r[0]!.error).not.toBeNull(); // a arrêtée
        expect(r[0]!.stopped).toBe(true);
        expect(r[1]!.error).toBeNull();
        const state = await loadRunState(paths);
        expect(destinationState(state, "a").lastSuccess).toBeUndefined();
        expect(destinationState(state, "b").lastSuccess).toBeDefined();
      });
    },
    60_000,
  );

  test.skipIf(!native)("stop_before_the_run_starts", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 1000);
      const paths = testPaths(dir);
      const config = testConfig(
        [src],
        ["a", "b"].map((id) => ({ id, path: path.join(dir, `dest-${id}`) })),
      );
      // « Arrêter » sur « a » avant le lancement : « b » est sauvegardée quand même.
      const service = new BackupService(paths, config, testDeps());
      service.cancelDestination("a");
      const r = await service.run({ only: ["folder"] });
      expect(r.map((x) => x.destination)).toEqual(["b"]); // a passée sans démarrer
      expect(r[0]!.error).toBeNull();
      const state = await loadRunState(paths);
      expect(destinationState(state, "a").lastSuccess).toBeUndefined();
      expect(destinationState(state, "a").lastFailure).toBeUndefined();
      expect(destinationState(state, "b").lastSuccess).toBeDefined();
      // Toutes les destinations visées arrêtées avant le lancement : rien ne démarre.
      const both = new BackupService(paths, config, testDeps());
      both.cancelDestination("a");
      both.cancelDestination("b");
      const error = await both.run({ only: ["folder"] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).reason).toBe("cancelled");
    });
  });

  test.skipIf(!native)("stop_during_preparation", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 10);
      const paths = testPaths(dir);
      const config = testConfig([src], [{ id: "a", path: path.join(dir, "dest") }]);
      const service = new BackupService(paths, config, testDeps());
      // Le parcours des dossiers s'interrompt : la préparation lève l'arrêt.
      const walk = await service.parts(dir, {}, { isCancelled: () => true }).catch((e: unknown) => e);
      expect((walk as BackupError).reason).toBe("cancelled");
      // Arrêter la seule destination visée pendant la préparation arrête toute la sauvegarde, sans échec noté.
      service.on((e) => {
        if (e.type === "progress" && e.progress.phase === "preparing")
          service.cancelDestination(e.progress.destination);
      });
      const run = await service.run({ only: ["folder"] }).catch((e: unknown) => e);
      expect((run as BackupError).reason).toBe("cancelled");
      expect(destinationState(await loadRunState(paths), "a").lastFailure).toBeUndefined(); // un arrêt n'est pas un échec
      expect(existsSync(path.join(dir, "dest/cairn"))).toBe(false); // rien d'écrit
    });
  });

  test.skipIf(!native)("unreachable_destination_is_not_a_failure", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 1000);
      const paths = testPaths(dir);
      const config = testConfig(
        [src],
        [{ id: "usb", path: `/Volumes/cairn-absent-${process.pid}-${Date.now()}/dest` }],
      );
      const r = await new BackupService(paths, config, testDeps()).run({ only: ["folder"] });
      expect(r[0]!.waiting).toBe(true);
      const ds = destinationState(await loadRunState(paths), "usb");
      expect(ds.lastAttempt).toBeDefined();
      expect(ds.waitingSince).toBeDefined();
      expect(ds.lastFailure).toBeUndefined(); // une destination injoignable n'est pas un échec
    });
  });

  test("partial_version_does_not_break_links_retention_or_restore", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const ai = path.join(dir, "ai");
      const dest = path.join(dir, "dest");
      for (let i = 0; i < 10; i++) writeFile(path.join(src, `f${i}.bin`), 100_000);
      writeFile(path.join(ai, "s.jsonl"), 1000);
      const folderPart = backupPart("folder", "folders/src", src);
      const aiPart = backupPart("ai", "ai/codex/conversations", ai);
      const e = engine();
      const versions = versionsDir(dest, "m");
      const base = { root: dest, retention: { mode: "count", count: 1 } as const, dryRun: false, machine: "m" };
      const v1 = await e.run({ ...base, parts: [folderPart, aiPart], now: at("2026-11-01T120000") });
      const v2 = await e.run({ ...base, parts: [aiPart], now: at("2026-11-02T120000"), partial: true });
      expect(await isPartial(path.join(versions, v2.version!))).toBe(true);
      expect(readlinkSync(path.join(versions, "latest"))).toBe(v1.version!); // une partielle ne devient pas « latest »
      expect(await listVersions(versions)).toEqual([v1.version!, v2.version!]); // hors rétention
      const v3 = await e.run({ ...base, parts: [folderPart, aiPart], now: at("2026-11-03T120000") });
      expect(v3.filesTransferred).toBe(0); // les dossiers sont liés à v1, pas recopiés
      expect(await listVersions(versions)).toEqual([v3.version!]); // v1 hors rétention, v2 remplacée
      const sums = await readChecksums(path.join(versions, v3.version!));
      expect([...sums.keys()].filter((k) => k.startsWith("folders/src/"))).toHaveLength(10);
    });
  });

  test.skipIf(!native)("logs_of_kept_versions_are_spared", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      writeFile(path.join(src, "a.bin"), 10_000);
      const paths = testPaths(dir);
      const config = testConfig([src], [{ id: "local", path: dest, retention: { mode: "count", count: 1 } }]);
      const clock = new TestClock(new Date());
      const deps = testDeps({ now: clock.now });
      await new BackupService(paths, config, deps).run();
      clock.advance(2000); // un autre nom de journal (horodatage à la seconde)
      await new BackupService(paths, config, deps).run();
      const kept = keptLogs(await loadRunState(paths));
      const versions = versionsDir(dest, "m");
      expect(await listVersions(versions)).toHaveLength(1);
      expect(kept).toEqual(new Set(await versionLogs(versions)));
      expect(kept.size).toBe(1);
      // Les deux journaux ont 200 jours : seul celui de la version gardée reste.
      const logs = readdirSync(paths.logs).filter((l) => l.startsWith("backup-"));
      expect(logs).toHaveLength(2);
      const old = new Date(Date.now() - 200 * 86_400_000);
      for (const l of logs) utimesSync(path.join(paths.logs, l), old, old);
      expect(await pruneLogs(paths, 90, kept)).toHaveLength(1);
      expect(existsSync(path.join(paths.logs, [...kept][0]!))).toBe(true);
    });
  });

  test("restore_opens_image_of_another_mac_with_typed_password", async () => {
    await withTempDir(async (dir) => {
      const dest = path.join(dir, "dest");
      mkdirSync(dest);
      const secrets = new MemorySecrets();
      const old = SparseImage.forMachine(dest, "selftest", true, "OldMac", { secrets });
      try {
        const pw = (await old.create("100m"))!;
        const mp = await old.attach();
        writeFile(path.join(mp, "cairn/OldMac/versions/2026-11-01T100000/home/.zshrc"), 10);
        await old.detach();
        secrets.images.clear(); // Mac neuf : Trousseau vide
        const d = { id: "selftest", provider: "local" as const, path: dest, encrypted: true, retention: rec };
        const s1 = new DestinationSession(d, { secrets, machine: "NewMac" });
        const error = await s1.open(false).catch((e: unknown) => e);
        await s1.close();
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).reason).toBe("missingImagePassword"); // le mot de passe est demandé
        expect(readdirSync(dest).filter((n) => n.endsWith(".sparsebundle"))).toHaveLength(1); // rien créé
        const s2 = new DestinationSession(d, { secrets, machine: "NewMac" });
        s2.imagePassword = pw;
        const root = await s2.open(false);
        try {
          expect(readdirSync(path.join(root, "cairn"))).toEqual(["OldMac"]);
        } finally {
          await s2.close();
        }
      } finally {
        detachImagesUnder(dir);
      }
    });
  }, 60_000);

  test("dry_run_after_a_backup_lists_only_changes", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      for (let i = 0; i < 5; i++) writeFile(path.join(src, `f${i}.bin`), 10_000);
      const part = backupPart("folder", "folders/src", src);
      const e = engine();
      await e.run({
        parts: [part],
        root: dest,
        retention: rec,
        dryRun: false,
        machine: "m",
        now: at("2026-11-01T120000"),
      });
      writeFile(path.join(src, "new.bin"), 1234);
      const before = execFileSync("/usr/bin/find", [dest], { encoding: "utf8" });
      const sim = await e.run({
        parts: [part],
        root: dest,
        retention: rec,
        dryRun: true,
        machine: "m",
        now: at("2026-11-02T120000"),
      });
      expect(sim.filesTransferred).toBe(1);
      expect(sim.bytesTransferred).toBe(1234);
      expect(execFileSync("/usr/bin/find", [dest], { encoding: "utf8" })).toBe(before); // rien d'écrit
    });
  });
});
