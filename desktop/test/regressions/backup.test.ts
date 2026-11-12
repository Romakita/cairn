// Régressions de la sauvegarde (parity/behavior.md §2) : un test par commit corrigé dans la 0.8.0.
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { BackupEngine } from "../../src/core/backup/engine.ts";
import { attachFailure, SparseImage } from "../../src/core/backup/image.ts";
import { readChecksums, writeChecksums } from "../../src/core/backup/integrity.ts";
import type { DestinationProgress } from "../../src/core/backup/progress.ts";
import { detectRsync, rsyncArgs } from "../../src/core/backup/rsync.ts";
import { BackupService } from "../../src/core/backup/run.ts";
import { destinationState, loadRunState, updateRunState } from "../../src/core/backup/run-state.ts";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { backupPart } from "../../src/core/backup/types.ts";
import { INCOMPLETE_PREFIX, listVersions, versionName, versionsDir } from "../../src/core/backup/versions.ts";
import { RECOMMENDED_RETENTION } from "../../src/core/config.ts";
import { setLanguage } from "../../src/core/l10n.ts";
import { AC_POWER, decide } from "../../src/core/schedule/schedule.ts";
import { TestClock, testConfig, testDeps, testPaths, withTempDir, writeFile } from "../helpers/backup-env.ts";
import { fakeImageHdiutil, wrappedRsync } from "../helpers/backup-fakes.ts";
import { nativeAvailable } from "../helpers/native.ts";

const run = promisify(execFile);
const native = nativeAvailable();
const daily = {
  frequency: "daily",
  time: "12:00",
  weekday: "monday",
  background: false,
  onBatteryMinPercent: 20,
} as const;

function progressOf(service: BackupService): DestinationProgress[] {
  const out: DestinationProgress[] = [];
  service.on((e) => {
    if (e.type === "progress") out.push(e.progress);
  });
  return out;
}

describe.skipIf(!native)("regressions: backup", () => {
  test("bfbbb61: arrêter A ne touche pas B ; un arrêt pendant la préparation n'est pas un échec", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      for (let i = 0; i < 10; i++) writeFile(path.join(src, `f${i}.bin`), 3_000_000);
      const paths = testPaths(dir);
      const config = testConfig(
        [src],
        [
          { id: "a", path: path.join(dir, "dest-a") },
          { id: "b", path: path.join(dir, "dest-b") },
        ],
      );
      const service = new BackupService(paths, config, testDeps());
      service.on((e) => {
        if (e.type === "progress" && e.progress.destination === "a" && e.progress.copy) service.cancelDestination("a");
      });
      const r = await service.run();
      expect(r.map((x) => [x.destination, x.stopped, x.error === null])).toEqual([
        ["a", true, false],
        ["b", false, true],
      ]);
      // Préparation : rien d'écrit dans dest/cairn, pas de lastFailure, pas de notification.
      const prep = testConfig([src], [{ id: "c", path: path.join(dir, "dest-c") }]);
      const s2 = new BackupService(paths, prep, testDeps());
      const notes: unknown[] = [];
      s2.on((e) => {
        if (e.type === "notification") notes.push(e);
        if (e.type === "progress" && e.progress.phase === "preparing") s2.cancelDestination("c");
      });
      expect(await s2.run().catch((e: Error) => e.message)).toBe("Backup cancelled");
      expect(destinationState(await loadRunState(paths), "c").lastFailure).toBeUndefined();
      expect(notes).toEqual([]);
      expect(existsSync(path.join(dir, "dest-c/cairn"))).toBe(false);
    });
  });

  test("a7d22bf: aucune attente synchrone, la boucle d'événements reste libre pendant une sauvegarde", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "big.bin"), 200_000_000);
      for (let i = 0; i < 200; i++) writeFile(path.join(src, `d${i % 10}/f${i}.txt`), 100);
      const config = testConfig([src], [{ id: "a", path: path.join(dir, "dest") }]);
      let last = Date.now();
      let worst = 0;
      const timer = setInterval(() => {
        const now = Date.now();
        worst = Math.max(worst, now - last);
        last = now;
      }, 10);
      // Une autre tâche asynchrone (comme une analyse git) avance pendant la sauvegarde.
      let ticks = 0;
      const other = (async () => {
        while (ticks < 1000) {
          await new Promise((r) => setTimeout(r, 1));
          ticks += 1;
        }
      })();
      try {
        const r = await new BackupService(testPaths(dir), config, testDeps()).run();
        expect(r[0]!.error).toBeNull();
      } finally {
        clearInterval(timer);
      }
      await other;
      expect(worst).toBeLessThan(250);
    });
  }, 60_000);

  test("0fa14ea: passe de nettoyage seulement si tout a réussi ; GNU rsync en un seul rsync ; total de reprise", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      const dest = path.join(dir, "dest");
      writeFile(path.join(src, "a/f.txt"), 10);
      writeFile(path.join(src, "b/g.txt"), 10);
      writeFile(path.join(src, "top.txt"), 10);
      const rsync = wrappedRsync(path.join(dir, "bin"));
      const part = backupPart("folder", "folders/src", src);
      // Reprise réussie, par morceaux (openrsync) : la passe --existing --ignore-existing tourne.
      const work = path.join(versionsDir(dest, "m"), INCOMPLETE_PREFIX + versionName(new Date(Date.now() - 60_000)));
      writeFile(path.join(work, "folders/src/gone.txt"), 10);
      const e1 = new BackupEngine({ rsync: { path: rsync.path, gnu: false } });
      const c1 = await e1.copy({
        parts: [part],
        root: dest,
        retention: RECOMMENDED_RETENTION,
        dryRun: false,
        machine: "m",
      });
      const copies = rsync.calls().filter((a) => a.includes("--out-format=%i|%n") && !a.includes("-n"));
      expect(copies.filter((a) => a.some((x) => x.startsWith("--include=")))).toHaveLength(3); // a, b, fichiers
      const cleanup = copies.filter((a) => a.includes("--existing"));
      expect(cleanup).toHaveLength(1);
      expect(cleanup[0]).toContain("--ignore-existing");
      expect(cleanup[0]).toContain("--delete-excluded");
      expect(existsSync(path.join(work, "folders/src/gone.txt"))).toBe(false);
      // Reprise : l'ancien total est gardé si le comptage n'a pas fini, jamais les seuls fichiers vus.
      expect(c1.filesByPart["folders/src"] === undefined || c1.filesByPart["folders/src"] === 3).toBe(true);
      // GNU rsync (-H) : la partie est copiée en un seul rsync, sans filtre de morceau.
      const gnuDir = path.join(dir, "gnu");
      const gnu = wrappedRsync(path.join(dir, "bin-gnu"));
      const e2 = new BackupEngine({ rsync: { path: gnu.path, gnu: true } });
      await e2.copy({ parts: [part], root: gnuDir, retention: RECOMMENDED_RETENTION, dryRun: false, machine: "m" });
      const gnuCopies = gnu.calls().filter((a) => !a.includes("-n"));
      expect(gnuCopies).toHaveLength(1);
      expect(gnuCopies[0]![1]).toBe("-H");
      expect(gnuCopies[0]!.some((a) => a.startsWith("--include="))).toBe(false);
      // Un morceau en échec : pas de passe de nettoyage.
      const failing = path.join(dir, "fail-dest");
      writeFile(
        path.join(
          versionsDir(failing, "m"),
          INCOMPLETE_PREFIX + versionName(new Date(Date.now() - 60_000)),
          "folders/src/keep.txt",
        ),
        10,
      );
      const r3 = wrappedRsync(path.join(dir, "bin-fail"));
      r3.failWith(23);
      const e3 = new BackupEngine({ rsync: { path: r3.path, gnu: false } });
      const c3 = await e3.copy({
        parts: [part],
        root: failing,
        retention: RECOMMENDED_RETENTION,
        dryRun: false,
        machine: "m",
      });
      expect(c3.warnings.length).toBeGreaterThan(0);
      expect(r3.calls().some((a) => a.includes("--existing"))).toBe(false);
    });
  });

  test("eb1fc60 / 75bde76: copie vers B pendant la finalisation de A ; fin de chaque destination ; étapes dans l'ordre", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "big.bin"), 150_000_000);
      const paths = testPaths(dir);
      // A : destination chiffrée (image simulée) ; B : dossier en clair.
      const config = testConfig(
        [src],
        [
          { id: "a", path: path.join(dir, "dest-a"), encrypted: true },
          { id: "b", path: path.join(dir, "dest-b") },
        ],
      );
      mkdirSync(path.join(dir, "dest-a"));
      const hdiutil = fakeImageHdiutil(path.join(dir, "mounted-a"));
      const service = new BackupService(paths, config, testDeps({ hdiutil: hdiutil.runner }));
      const progress = progressOf(service);
      let bCopiedWhileAFinishing = false;
      service.on((e) => {
        if (e.type !== "progress" || e.progress.destination !== "b" || !e.progress.copy) return;
        if (service.progress().find((p) => p.destination === "a")?.phase === "finishing") bCopiedWhileAFinishing = true;
      });
      const r = await service.run();
      expect(r.map((x) => x.error)).toEqual([null, null]);
      expect(bCopiedWhileAFinishing).toBe(true);
      for (const id of ["a", "b"]) expect(progress.filter((p) => p.destination === id).at(-1)!.phase).toBe("done");
      // Première sauvegarde : vérification du mois, image comprise, puis compactage.
      const a = progress.filter((p) => p.destination === "a").at(-1)!;
      expect(a.finishing!.map((s) => [s.id, s.status])).toEqual([
        ["listing", "done"],
        ["checksums", "done"],
        ["version", "done"],
        ["sample", "done"],
        ["image", "done"],
        ["compact", "done"],
      ]);
      expect(hdiutil.calls.map((c) => c[0])).toEqual(["create", "attach", "detach", "verify", "compact"]);
    });
  }, 60_000);

  test("593f593: hachage en flux, mémoire stable (< 64 Mo de croissance) sur un fichier de 512 Mo", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "big.bin");
      writeFileSync(file, "");
      truncateSync(file, 512 << 20); // fichier creux de 512 Mo
      const helper = path.resolve(import.meta.dir, "../helpers/backup-hash-footprint.ts");
      // Mesuré dans un processus à part : les autres tests fausseraient la mémoire de celui-ci.
      const { stdout } = await run(process.execPath, [helper, file]);
      const [hash, growth] = stdout.trim().split(" ");
      expect(hash).toBe("9acca8e8c22201155389f65abbf6bc9723edc7384ead80503839f49dcc56d767");
      expect(Number(growth)).toBeLessThan(64 << 20);
      // Même mesure sous le Node d'Electron (le vrai moteur d'exécution), s'il est installé.
      const electron = path.resolve(
        import.meta.dir,
        "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      );
      if (existsSync(electron)) {
        const node = await run(electron, ["--experimental-transform-types", "--no-warnings", helper, file], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
        const [h2, g2] = node.stdout.trim().split(" ");
        expect(h2).toBe(hash!);
        expect(Number(g2)).toBeLessThan(64 << 20);
      }
    });
  }, 60_000);

  test("c459b58: destination injoignable = attente, pas d'échec ; à son retour, décision « run » immédiate", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 10);
      const paths = testPaths(dir);
      const config = testConfig([src], [{ id: "usb", path: `/Volumes/cairn-absent-${process.pid}/dest` }]);
      const service = new BackupService(paths, config, testDeps());
      const progress = progressOf(service);
      const r = await service.run();
      expect(r[0]!.waiting).toBe(true);
      expect(progress.at(-1)!.phase).toBe("waiting");
      const ds = destinationState(await loadRunState(paths), "usb");
      expect(ds.lastAttempt).toBeDefined();
      expect(ds.waitingSince).toBeDefined();
      expect(ds.lastFailure).toBeUndefined();
      const now = new Date();
      // Jamais sauvegardée, aucun échec noté : la sauvegarde due part tout de suite, sans délai d'après échec.
      expect(
        decide(daily, {
          lastSuccess: ds.lastSuccess,
          lastFailure: ds.lastFailure,
          now,
          running: false,
          power: AC_POWER,
          reachable: true,
        }),
      ).toBe("run");
    });
  });

  test("7cc955d: une erreur de préparation est notée sur chaque destination ; nouvel essai dans une heure", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 10);
      const paths = testPaths(dir);
      const config = testConfig(
        [src],
        [
          { id: "a", path: path.join(dir, "dest-a") },
          { id: "b", path: path.join(dir, "dest-b") },
        ],
      );
      const deps = testDeps({
        aiParts: async () => {
          throw new Error("AI database unreadable");
        },
      });
      const service = new BackupService(paths, config, deps);
      const notes: string[] = [];
      service.on((e) => {
        if (e.type === "notification") notes.push(e.notification.body);
      });
      await expect(service.run()).rejects.toThrow("AI database unreadable");
      const state = await loadRunState(paths);
      for (const id of ["a", "b"]) {
        const ds = destinationState(state, id);
        expect(ds.lastAttempt).toBeDefined();
        expect(ds.lastFailure).toBeDefined();
        expect(ds.lastError).toBe("AI database unreadable");
        const later = new Date(ds.lastFailure!.getTime() + 20 * 60_000);
        expect(
          decide(daily, { lastFailure: ds.lastFailure, now: later, running: false, power: AC_POWER, reachable: true }),
        ).toBe("retryLater");
      }
      expect(notes).toEqual(["AI database unreadable"]);
      expect(readFileSync(service.logFile!, "utf8")).toContain("error before destinations: AI database unreadable");
    });
  });

  test("46a9475: pas de rsync lancé après l'arrêt ; état relu avant d'écrire ; pas de realpath par fichier", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a/x.bin"), 10);
      writeFile(path.join(src, "b/y.bin"), 10);
      const rsync = wrappedRsync(path.join(dir, "bin"));
      const e = new BackupEngine({ rsync: { path: rsync.path, gnu: false } });
      e.cancel();
      const error = await e
        .copy({
          parts: [backupPart("folder", "folders/src", src)],
          root: path.join(dir, "d"),
          retention: RECOMMENDED_RETENTION,
          dryRun: false,
          machine: "m",
        })
        .catch((x: Error) => x);
      expect((error as Error).message).toBe("Backup cancelled");
      expect(rsync.calls()).toEqual([]); // rien lancé
      // Notice de retard écrite par l'app pendant la sauvegarde : gardée.
      const paths = testPaths(dir);
      const config = testConfig([src], [{ id: "a", path: path.join(dir, "dest") }]);
      const service = new BackupService(paths, config, testDeps());
      const notice = new Date("2026-11-08T10:00:00Z");
      let written = false;
      service.on((ev) => {
        if (ev.type === "progress" && ev.progress.copy && !written) {
          written = true;
          void updateRunState(paths, (s) => {
            const ds = destinationState(s, "a");
            ds.lastOverdueNotice = notice;
            s.destinations.a = ds;
          });
        }
      });
      await service.run();
      await new Promise((r) => setTimeout(r, 50));
      const ds = destinationState(await loadRunState(paths), "a");
      expect(ds.lastOverdueNotice?.getTime()).toBe(notice.getTime());
      expect(ds.lastSuccess).toBeDefined();
      // Version atteinte par un lien (/var → /private/var) : chemins relatifs justes, sans résolution par fichier.
      const real = path.join(dir, "real-version");
      writeFile(path.join(real, "folders/x/f.txt"), 3);
      symlinkSync(real, path.join(dir, "linked"));
      await writeChecksums(path.join(dir, "linked"), {});
      expect([...(await readChecksums(real)).keys()]).toEqual(["folders/x/f.txt"]);
    });
  });

  test("e229e52: simulation contre la version de base avec openrsync, sans rien créer", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a/1.bin"), 100);
      writeFile(path.join(src, "b/2.bin"), 100);
      const paths = testPaths(dir);
      const dest = path.join(dir, "dest");
      const config = testConfig([src], [{ id: "a", path: dest }]);
      const clock = new TestClock(new Date());
      await new BackupService(paths, config, testDeps({ now: clock.now })).run();
      writeFile(path.join(src, "b/3.bin"), 7);
      const listing = await run("/usr/bin/find", [dest]);
      clock.advance(2000);
      const r = await new BackupService(paths, config, testDeps({ now: clock.now })).run({ dryRun: true });
      expect(r[0]!.error).toBeNull(); // openrsync -n sans --link-dest absent
      expect(r[0]!.outcome!.filesTransferred).toBe(1);
      expect(r[0]!.outcome!.bytesTransferred).toBe(7);
      expect((await run("/usr/bin/find", [dest])).stdout).toBe(listing.stdout);
    });
  });

  test("3692993: simulation sans image ni dossier ; partielle hors latest et rétention ; journaux gardés ; pas d'état", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 100);
      const paths = testPaths(dir);
      const dest = path.join(dir, "dest");
      mkdirSync(dest);
      const hdiutil = fakeImageHdiutil(path.join(dir, "mounted"));
      const enc = testConfig([src], [{ id: "a", path: dest, encrypted: true }]);
      await new BackupService(paths, enc, testDeps({ hdiutil: hdiutil.runner })).run({ dryRun: true });
      expect(readdirSync(dest)).toEqual([]); // ni image ni dossier
      expect(hdiutil.calls.some((c) => c[0] === "create")).toBe(false);
      expect(existsSync(path.join(paths.state, "runs.json"))).toBe(false); // ni état
      expect(existsSync(path.join(paths.state, "activity.jsonl"))).toBe(false); // ni activité
      // Version partielle : pas « latest », gardée hors rétention.
      const plain = testConfig(
        [src],
        [{ id: "p", path: path.join(dir, "plain"), retention: { mode: "count", count: 1 } }],
      );
      const clock = new TestClock(new Date());
      const full = await new BackupService(paths, plain, testDeps({ now: clock.now })).run();
      clock.advance(2000);
      const part = await new BackupService(paths, plain, testDeps({ now: clock.now })).run({ only: ["folder"] });
      const versions = versionsDir(path.join(dir, "plain"), "m");
      expect(readlinkSync(path.join(versions, "latest"))).toBe(full[0]!.outcome!.version!);
      expect(await listVersions(versions)).toEqual([full[0]!.outcome!.version!, part[0]!.outcome!.version!]);
      const kept = destinationState(await loadRunState(paths), "p").keptLogs!;
      expect(kept).toHaveLength(2);
      expect(kept.every((l) => existsSync(path.join(paths.logs, l)))).toBe(true);
    });
  });

  test("bfa7ccc: vraie version dans le manifest, vérification mensuelle de l'image, échec notifié avec le journal", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 100);
      const paths = testPaths(dir);
      const dest = path.join(dir, "dest");
      mkdirSync(dest);
      const hdiutil = fakeImageHdiutil(path.join(dir, "mounted"));
      const config = testConfig([src], [{ id: "a", path: dest, encrypted: true }]);
      const clock = new TestClock(new Date());
      // Un seul Trousseau (en mémoire) pour les trois sauvegardes : le mot de passe de l'image y reste.
      const deps = testDeps({ hdiutil: hdiutil.runner, now: clock.now });
      const r1 = await new BackupService(paths, config, deps).run();
      expect(r1[0]!.imageCheck?.ok).toBe(true);
      const manifest = JSON.parse(
        readFileSync(path.join(dir, "mounted/cairn/m/versions/latest/manifest.json"), "utf8"),
      );
      expect(manifest.cairn).toMatch(/^\d+\.\d+\.\d+/);
      // Le mois suivant seulement : pas de nouveau contrôle le lendemain.
      clock.advance(86_400_000);
      hdiutil.calls.length = 0;
      const r2 = await new BackupService(paths, config, deps).run();
      expect(r2[0]!.error).toBeNull();
      expect(hdiutil.calls.some((c) => c[0] === "verify")).toBe(false);
      clock.advance(31 * 86_400_000);
      const r3 = await new BackupService(paths, config, deps).run();
      expect(r3[0]!.error).toBeNull();
      expect(hdiutil.calls.some((c) => c[0] === "verify")).toBe(true);
    });
  });

  test("0547a02: les 20 dernières lignes d'erreur de rsync dans l'erreur et le journal ; image verrouillée ; pas de compactage après un échec", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 100);
      const paths = testPaths(dir);
      const dest = path.join(dir, "dest");
      mkdirSync(dest);
      const rsync = wrappedRsync(path.join(dir, "bin"));
      rsync.failWith(12);
      const hdiutil = fakeImageHdiutil(path.join(dir, "mounted"));
      const config = testConfig([src], [{ id: "a", path: dest, encrypted: true }]);
      const r = await new BackupService(
        paths,
        config,
        testDeps({ hdiutil: hdiutil.runner, rsync: { path: rsync.path, gnu: false } }),
      ).run();
      const error = r[0]!.error!;
      expect(error).toContain("rsync code 12");
      expect(error).toContain("rsync: error line 25");
      expect(error).toContain("rsync: error line 6");
      expect(error).not.toContain("rsync: error line 5\n");
      expect(readFileSync(r[0]!.log!, "utf8")).toContain("rsync: error line 25");
      expect(hdiutil.calls.some((c) => c[0] === "compact")).toBe(false); // pas de compactage après un échec
      expect(hdiutil.calls.some((c) => c[0] === "detach")).toBe(true); // image détachée quand même
      // Image tenue par un autre processus : message clair, en anglais comme en français.
      for (const out of [
        "hdiutil: attach failed - Resource temporarily unavailable",
        "attach a échoué - Ressources temporairement indisponibles",
      ]) {
        expect(attachFailure(out, "/n/cairn-m.sparsebundle").reason).toBe("imageBusy");
      }
      setLanguage("fr-FR");
      try {
        expect(attachFailure("Resource temporarily unavailable", "/n/cairn-m.sparsebundle").message).toContain(
          "cairn-m.sparsebundle",
        );
      } finally {
        setLanguage("en-US");
      }
    });
  });

  test("1e10810: les notifications sont des événements, jamais affichées par le core", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "a.bin"), 10);
      const dest = path.join(dir, "dest");
      writeFileSync(dest, "file, not folder");
      const service = new BackupService(testPaths(dir), testConfig([src], [{ id: "a", path: dest }]), testDeps());
      const kinds: string[] = [];
      service.on((e) => {
        if (e.type === "notification") kinds.push(e.notification.kind);
      });
      await service.run();
      expect(kinds).toEqual(["failed"]);
      const sources = readdirSync(path.resolve(import.meta.dir, "../../src/core/backup"));
      for (const f of sources) {
        const text = readFileSync(path.resolve(import.meta.dir, "../../src/core/backup", f), "utf8");
        expect(text).not.toMatch(/from "electron"|Notification\(/);
      }
    });
  });

  describe("contrôle de l'image et fichiers spéciaux", () => {
    const BUSY =
      'hdiutil: verify: unable to recognize "/n/cairn-m.sparsebundle" as a disk image. (Ressources temporairement indisponibles)';

    test("image check failed right after detach: verify is retried while the image is still locked", async () => {
      const replies = [BUSY, BUSY, 'hdiutil: verify: checksum of "x" failed: image has no checksum'];
      const calls: string[][] = [];
      const waits: number[] = [];
      const img = SparseImage.forMachine("/n", "main", false, "m", {
        secrets: new MemorySecrets(),
        hdiutil: async (args) => {
          calls.push([...args]);
          return { code: 1, output: replies[calls.length - 1] ?? BUSY };
        },
        wait: async (ms) => {
          waits.push(ms);
        },
      });
      const check = await img.verify();
      expect(check.ok).toBe(true);
      expect(calls).toHaveLength(3);
      expect(waits).toEqual([2000, 4000]);
    });

    test("image check failed right after detach: a lock that never clears still fails, after 5 tries", async () => {
      let tries = 0;
      const img = SparseImage.forMachine("/n", "main", false, "m", {
        secrets: new MemorySecrets(),
        hdiutil: async () => {
          tries++;
          return { code: 1, output: BUSY };
        },
        wait: async () => {},
      });
      const check = await img.verify();
      expect(check.ok).toBe(false);
      expect(check.output).toContain("Ressources temporairement indisponibles");
      expect(tries).toBe(5);
    });

    test("rsync 23 on sockets: a socket in a backed-up folder is skipped without warning", async () => {
      await withTempDir(async (dir) => {
        const source = path.join(dir, "s");
        writeFile(path.join(source, "data.txt"), 1);
        const sock = path.join(source, "dev.sock");
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(sock, resolve));
        try {
          const binary = await detectRsync();
          const dest = path.join(dir, "d");
          const args = rsyncArgs(binary, { source, dest, linkDest: null, dryRun: false }, {});
          const r = await promisify(execFile)(binary.path, args).then(
            () => 0,
            (e: { code?: number }) => e.code ?? -1,
          );
          expect(r).toBe(0);
          expect(existsSync(path.join(dest, "data.txt"))).toBe(true);
          expect(existsSync(path.join(dest, "dev.sock"))).toBe(false);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    });
  });
});
