// Modèle de progression (spec `backup` modifiée, « Simulation, progression et journal ») : un test par scénario,
// plus les règles du modèle (phases, compteurs, dossier n sur N, pourcentage plafonné, étapes de finalisation).
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  cappedPercent,
  type DestinationProgress,
  DestinationTracker,
  emptyResult,
} from "../../src/core/backup/progress.ts";
import { type BackupEvent, BackupService } from "../../src/core/backup/run.ts";
import { destinationState, loadRunState } from "../../src/core/backup/run-state.ts";
import { TestClock, testConfig, testDeps, testPaths, withTempDir, writeFile } from "../helpers/backup-env.ts";
import { nativeAvailable } from "../helpers/native.ts";

const native = nativeAvailable();

function collect(service: BackupService): { events: BackupEvent[]; progress: DestinationProgress[] } {
  const events: BackupEvent[] = [];
  const progress: DestinationProgress[] = [];
  service.on((e) => {
    events.push(e);
    if (e.type === "progress") progress.push(e.progress);
  });
  return { events, progress };
}

/** Phases successives (sans répétition) d'une destination. */
function phases(progress: readonly DestinationProgress[], id: string): string[] {
  const out: string[] = [];
  for (const p of progress) if (p.destination === id && out.at(-1) !== p.phase) out.push(p.phase);
  return out;
}

describe("backup-progress", () => {
  describe("modèle", () => {
    test("pourcentage plafonné à 99 avant la fin, 100 seulement à la fin réussie", () => {
      expect(cappedPercent(0, null)).toBeNull();
      expect(cappedPercent(5, 0)).toBeNull();
      expect(cappedPercent(50, 100)).toBe(50);
      expect(cappedPercent(100, 100)).toBe(99);
      expect(cappedPercent(130, 100)).toBe(99); // estimation trop courte
      const seen: DestinationProgress[] = [];
      const t = new DestinationTracker("a", false, (p) => seen.push(p), { throttleMs: 0 });
      t.startCounting(10);
      t.copy({ part: "folders/x", partIndex: 1, partCount: 1, processed: 10 });
      expect(t.snapshot().copy?.percent).toBe(99);
      t.finish(emptyResult("succeeded"));
      expect(t.snapshot().copy?.percent).toBe(100);
      expect(t.snapshot().phase).toBe("done");
    });

    test("compteurs visibles pendant tout le comptage, total connu jusqu'au nouveau total", () => {
      const t = new DestinationTracker("a", false, () => {}, { throttleMs: 0 });
      t.preparing({ key: "backup.prepare.parts", args: [] });
      expect(t.snapshot().phase).toBe("preparing");
      t.startCounting(200);
      expect(t.snapshot().phase).toBe("counting");
      t.counter(0, { folder: "alpha", found: 3, current: "alpha/a", done: false });
      t.counter(2, { folder: "gamma", found: 1, current: "", done: false });
      t.found(4);
      t.copy({
        part: "folders/x",
        partIndex: 1,
        partCount: 2,
        folderIndex: 1,
        folderCount: 3,
        folderName: "alpha",
        processed: 50,
      });
      const during = t.snapshot();
      // Copie et comptage ensemble : la phase reste « comptage », les compteurs restent visibles.
      expect(during.phase).toBe("counting");
      expect(during.counting?.counters.map((c) => c.folder)).toEqual(["alpha", "", "gamma"]);
      expect(during.counting?.found).toBe(4);
      expect(during.copy?.expected).toBe(200); // total connu
      expect(during.copy?.percent).toBe(25);
      t.countingDone(100);
      const after = t.snapshot();
      expect(after.phase).toBe("copying");
      expect(after.copy?.expected).toBe(100); // nouveau total
      expect(after.copy?.percent).toBe(50);
      // Sans total connu : pas de pourcentage tant que le comptage tourne.
      const u = new DestinationTracker("b", false, () => {}, { throttleMs: 0 });
      u.startCounting(null);
      u.copy({ part: "home", partIndex: 1, partCount: 1, processed: 10 });
      expect(u.snapshot().copy?.percent).toBeNull();
      u.countingDone(40);
      expect(u.snapshot().copy?.percent).toBe(25);
    });

    test("comptage interrompu par la fin de la copie : le total connu reste", () => {
      const t = new DestinationTracker("a", false, () => {}, { throttleMs: 0 });
      t.startCounting(80);
      t.copy({ part: "p", partIndex: 1, partCount: 1, processed: 40 });
      t.countingDone(null);
      expect(t.snapshot().copy?.expected).toBe(80);
      expect(t.snapshot().counting?.done).toBe(true);
    });

    test("dossier n sur N et liste en cours (depuis quand)", () => {
      let clock = 1000;
      const t = new DestinationTracker("a", false, () => {}, { throttleMs: 0, now: () => clock });
      t.startCounting(null);
      t.copy({
        part: "folders/w",
        partIndex: 1,
        partCount: 3,
        folderIndex: 2,
        folderCount: 5,
        folderName: "beta",
        listing: true,
      });
      expect(t.snapshot().copy).toMatchObject({
        folderIndex: 2,
        folderCount: 5,
        folderName: "beta",
        partIndex: 1,
        partCount: 3,
      });
      expect(t.snapshot().copy?.listingSince).toBe(1000);
      clock = 5000;
      t.copy({ folderIndex: 2, listing: true });
      expect(t.snapshot().copy?.listingSince).toBe(1000); // même dossier : depuis le début de la liste
      t.copy({ folderIndex: 2, listing: false, processed: 1 });
      expect(t.snapshot().copy?.listingSince).toBeNull();
      t.copy({ folderIndex: 3, folderName: null, listing: true });
      expect(t.snapshot().copy?.listingSince).toBe(5000);
      expect(t.snapshot().copy?.folderName).toBeNull(); // fichiers du premier niveau
    });

    test("étapes de finalisation dans l'ordre, avec leur avancement", () => {
      const t = new DestinationTracker("a", false, () => {}, { throttleMs: 0 });
      t.startCounting(null);
      t.copy({ part: "p", partIndex: 1, partCount: 1 });
      t.beginFinishing(["listing", "checksums", "version", "sample", "image", "compact"]);
      expect(t.snapshot().phase).toBe("finishing");
      expect(t.snapshot().counting?.done).toBe(true); // le comptage s'arrête avec la copie
      t.step("listing");
      t.step("checksums", { done: 3, total: 12, current: "p/a" });
      let s = t.snapshot().finishing!;
      expect(s.map((x) => x.status)).toEqual(["done", "running", "pending", "pending", "pending", "pending"]);
      expect(s[1]).toMatchObject({ done: 3, total: 12, percent: 25, current: "p/a" });
      t.step("version");
      t.step("compact"); // pas de vérification ce mois-ci : échantillon et image sautés
      s = t.snapshot().finishing!;
      expect(s.map((x) => x.status)).toEqual(["done", "done", "done", "skipped", "skipped", "running"]);
      t.finish(emptyResult("succeeded"));
      expect(t.snapshot().finishing!.at(-1)!.status).toBe("done");
    });

    test("échec pendant la finalisation : le compactage devient la fermeture", () => {
      const t = new DestinationTracker("a", false, () => {}, { throttleMs: 0 });
      t.beginFinishing(["listing", "checksums", "version", "compact"]);
      t.step("checksums", { done: 1, total: 2 });
      t.replaceStep("compact", "close");
      t.step("close");
      t.finish(emptyResult("failed", { error: "boom" }));
      const p = t.snapshot();
      expect(p.phase).toBe("failed");
      expect(p.finishing!.map((s) => s.id)).toEqual(["listing", "checksums", "version", "close"]);
      expect(p.result?.error).toBe("boom");
    });

    test("injoignable : phase « waiting » avec un résultat, arrêt : « stopped »", () => {
      const w = new DestinationTracker("a", false);
      w.finish(emptyResult("waiting"));
      expect(w.snapshot().phase).toBe("waiting");
      const s = new DestinationTracker("b", false);
      s.finish(emptyResult("stopped"));
      expect(s.snapshot().phase).toBe("stopped");
    });

    test("au plus dix envois par seconde, changement de phase envoyé tout de suite, dernier état garanti", async () => {
      const sent: DestinationProgress[] = [];
      const t = new DestinationTracker("a", false, (p) => sent.push(p), { throttleMs: 100 });
      t.startCounting(null); // phase : envoyé
      for (let i = 0; i < 500; i++) t.found(1);
      expect(sent.length).toBeLessThan(5);
      await new Promise((r) => setTimeout(r, 150));
      expect(sent.at(-1)?.counting?.found).toBe(500); // l'état en attente finit par partir
      t.finish(emptyResult("succeeded"));
      expect(sent.at(-1)?.phase).toBe("done");
    });

    test("l'instantané est sérialisable et indépendant", () => {
      const t = new DestinationTracker("a", true);
      t.startCounting(3);
      t.counter(0, { folder: "x", found: 1, current: "x/1", done: false });
      const snap = t.snapshot();
      expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
      t.counter(0, { folder: "y", found: 2, current: "", done: false });
      expect(snap.counting!.counters[0]!.folder).toBe("x");
    });
  });

  describe.skipIf(!native)("scénarios de la spec", () => {
    test("Simulation : volume à copier par partie, destination non modifiée", async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        const other = path.join(dir, "other");
        writeFile(path.join(src, "a.bin"), 30_000);
        writeFile(path.join(other, "b.bin"), 12_000);
        const dest = path.join(dir, "dest");
        const paths = testPaths(dir);
        const config = testConfig([src, other], [{ id: "local", path: dest }]);
        // Une vraie sauvegarde d'abord, puis une modification : la simulation compare à la version de base.
        await new BackupService(paths, config, testDeps()).run();
        writeFile(path.join(src, "new.bin"), 5_000);
        const before = execFileSync("/usr/bin/find", [dest, "-ls"], { encoding: "utf8" });
        const stateBefore = readFileSync(path.join(paths.state, "runs.json"), "utf8");
        const service = new BackupService(paths, config, testDeps());
        const { progress, events } = collect(service);
        const r = await service.run({ dryRun: true });
        expect(r[0]!.outcome!.bytesByPart).toEqual({ "folders/src": 5_000, "folders/other": 0 });
        expect(r[0]!.outcome!.version).toBeNull();
        expect(execFileSync("/usr/bin/find", [dest, "-ls"], { encoding: "utf8" })).toBe(before); // rien d'écrit
        expect(readFileSync(path.join(paths.state, "runs.json"), "utf8")).toBe(stateBefore); // ni l'état
        const last = progress.at(-1)!;
        expect(last.dryRun).toBe(true);
        expect(last.phase).toBe("done");
        expect(last.finishing).toBeNull(); // pas de finalisation en simulation
        expect(events.some((e) => e.type === "notification")).toBe(false);
      });
    });

    test("Notification d'échec : l'échec est notifié avec le journal", async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        writeFile(path.join(src, "a.bin"), 1000);
        // La destination est un fichier : impossible d'y créer les versions.
        const dest = path.join(dir, "dest");
        writeFileSync(dest, "not a folder");
        const paths = testPaths(dir);
        const config = testConfig([src], [{ id: "local", path: dest }]);
        const service = new BackupService(paths, config, testDeps());
        const { events, progress } = collect(service);
        const r = await service.run();
        expect(r[0]!.error).not.toBeNull();
        const n = events.flatMap((e) => (e.type === "notification" ? [e.notification] : []));
        expect(n).toHaveLength(1);
        expect(n[0]).toMatchObject({ kind: "failed", destination: "local", body: r[0]!.error });
        expect(n[0]!.log).toBe(r[0]!.log);
        expect(readFileSync(n[0]!.log!, "utf8")).toContain("local: error");
        expect(progress.at(-1)!.phase).toBe("failed");
        expect(destinationState(await loadRunState(paths), "local").lastFailure).toBeDefined();
        // Une simulation qui échoue ne notifie pas.
        const dry = new BackupService(paths, config, testDeps());
        const dryEvents = collect(dry).events;
        await dry.run({ dryRun: true });
        expect(dryEvents.some((e) => e.type === "notification")).toBe(false);
      });
    });

    test("Comptage avec un total déjà connu : compteurs affichés pendant tout le comptage", async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        for (let i = 0; i < 60; i++) writeFile(path.join(src, `d${i % 6}/f${i}.bin`), 100);
        const paths = testPaths(dir);
        const config = testConfig([src], [{ id: "local", path: path.join(dir, "dest") }]);
        const clock = new TestClock(new Date());
        await new BackupService(paths, config, testDeps({ now: clock.now })).run();
        expect(destinationState(await loadRunState(paths), "local").fileCounts).toEqual({ "folders/src": 60 });
        for (let i = 60; i < 66; i++) writeFile(path.join(src, `d0/g${i}.bin`), 100);
        clock.advance(2000); // autre nom de version
        const service = new BackupService(paths, config, testDeps({ now: clock.now }));
        const { progress } = collect(service);
        await service.run();
        const counting = progress.filter((p) => p.phase === "counting");
        expect(counting.length).toBeGreaterThan(0);
        // Le comptage tourne malgré le total connu, et ses compteurs sont visibles.
        expect(counting.every((p) => p.counting?.knownTotal === 60)).toBe(true);
        expect(counting.some((p) => (p.counting?.counters.length ?? 0) > 0)).toBe(true);
        expect(counting.some((p) => p.counting!.counters.some((c) => c.folder.startsWith("d")))).toBe(true);
        // Pourcentage sur le total connu jusqu'à la fin du nouveau comptage, puis sur le nouveau total.
        for (const p of counting) if (p.copy) expect(p.copy.expected).toBe(60);
        const afterCount = progress.filter((p) => p.counting?.done && p.counting.total !== null && p.copy && !p.result);
        for (const p of afterCount) expect(p.copy!.expected).toBe(66);
        expect(progress.every((p) => p.result || (p.copy?.percent ?? 0) <= 99)).toBe(true);
        expect(destinationState(await loadRunState(paths), "local").fileCounts).toEqual({ "folders/src": 66 });
      });
    });

    test("Deux destinations : la première se finalise pendant la copie de la seconde", async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        writeFile(path.join(src, "big.bin"), 200_000_000);
        writeFile(path.join(src, "small.txt"), 10);
        const paths = testPaths(dir);
        const config = testConfig(
          [src],
          ["a", "b"].map((id) => ({ id, path: path.join(dir, `dest-${id}`) })),
        );
        const service = new BackupService(paths, config, testDeps());
        let overlap: { a: DestinationProgress; b: DestinationProgress } | null = null;
        service.on((e) => {
          if (e.type !== "progress" || e.progress.destination !== "b" || overlap) return;
          if (e.progress.phase !== "counting" && e.progress.phase !== "copying") return;
          const a = service.progress().find((p) => p.destination === "a")!;
          if (a.phase === "finishing") overlap = { a, b: e.progress };
        });
        const r = await service.run();
        expect(r.map((x) => x.error)).toEqual([null, null]);
        expect(overlap).not.toBeNull();
        const o = overlap as unknown as { a: DestinationProgress; b: DestinationProgress };
        // La carte de « a » montre ses étapes de finalisation, celle de « b » sa propre copie.
        expect(o.a.finishing!.map((s) => s.id).slice(0, 3)).toEqual(["listing", "checksums", "version"]);
        expect(o.a.finishing!.some((s) => s.status === "running")).toBe(true);
        expect(o.b.copy ?? o.b.counting).not.toBeNull();
        expect(o.b.finishing).toBeNull();
      });
    }, 120_000);

    test("Arrêt pendant la préparation : pas d'échec ni de notification", async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        writeFile(path.join(src, "a.bin"), 10);
        const paths = testPaths(dir);
        const config = testConfig([src], [{ id: "a", path: path.join(dir, "dest") }]);
        const service = new BackupService(paths, config, testDeps());
        const { events, progress } = collect(service);
        service.on((e) => {
          if (e.type === "progress" && e.progress.phase === "preparing") service.cancel();
        });
        await service.run().catch(() => {});
        expect(events.some((e) => e.type === "notification")).toBe(false);
        expect(progress.at(-1)!.phase).toBe("stopped");
        expect(phases(progress, "a")).toEqual(["preparing", "stopped"]);
      });
    });

    test("Chaque phase dans l'ordre jusqu'à « terminé »", async () => {
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        for (let i = 0; i < 20; i++) writeFile(path.join(src, `d${i % 4}/f${i}.bin`), 1000);
        const paths = testPaths(dir);
        const config = testConfig([src], [{ id: "a", path: path.join(dir, "dest") }]);
        const service = new BackupService(paths, config, testDeps());
        const { progress } = collect(service);
        await service.run();
        const seq = phases(progress, "a");
        expect(seq[0]).toBe("preparing");
        expect(seq.at(-1)).toBe("done");
        const order = ["preparing", "counting", "copying", "finishing", "done"];
        for (const phase of order) expect(seq).toContain(phase);
        // Ordre respecté (une phase ne revient pas en arrière).
        const ranks = seq.map((p) => order.indexOf(p));
        expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
      });
    });
  });
});
