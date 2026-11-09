// Régressions de parity/behavior.md §2 qui touchent la planification et les destinations : un test par commit.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalProvider } from "../../src/core/backup/providers.ts";
import { emptyDestinationState, loadRunState, saveRunState } from "../../src/core/backup/run-state.ts";
import { dateOfVersion } from "../../src/core/backup/versions.ts";
import { defaultConfig, destination, RECOMMENDED_RETENTION } from "../../src/core/config.ts";
import { ConfigSaveError, ConfigStore } from "../../src/core/config-store.ts";
import { unavailableReason } from "../../src/core/destinations/actions.ts";
import { saveEditedDestination, saveNewDestination } from "../../src/core/destinations/edit.ts";
import { checkFolder, chooseImage, listShares, WRITE_TEST_PREFIX } from "../../src/core/destinations/probe.ts";
import { planRemoval, removeDestination } from "../../src/core/destinations/removal.ts";
import { type NativeBinding, native, setNative } from "../../src/core/native.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import type { ProcessResult } from "../../src/core/process.ts";
import { localCalendar } from "../../src/core/schedule/calendar.ts";
import { AC_POWER, decide } from "../../src/core/schedule/schedule.ts";
import { fileRunStatePort, type RunStatePort, recordOverdueNotices } from "../../src/core/schedule/tick.ts";
import { nativeAvailable } from "../helpers/native.ts";

const at = (name: string): Date => dateOfVersion(name)!;
const daily = { ...defaultConfig().schedule, frequency: "daily" as const, time: "12:00" };

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "cairn-regression-")));
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

function processResult(code: number, stdout: string, stderr: string[] = []): ProcessResult {
  return { code, signal: null, stdout, stderrTail: stderr, timedOut: false, cancelled: false, launched: true };
}

/** Destination de test (dossier local temporaire) et son `config.toml`, avec un état posé dans `runs.json`. */
async function fixture() {
  const dir = await tempDir();
  const paths = new CairnPaths(path.join(dir, "home"));
  const store = new ConfigStore(paths);
  const dest = path.join(dir, "dest");
  await mkdir(path.join(dest, "cairn-Ce-Mac.sparsebundle", "bands"), { recursive: true });
  await writeFile(path.join(dest, "cairn-Ce-Mac.sparsebundle", "bands", "0"), "x");
  const c = defaultConfig();
  c.destinations = [
    destination("main", "local", { path: path.join(dir, "autre"), encrypted: false }),
    destination("usb", "local", { path: dest, encrypted: true }),
  ];
  await store.save(c);
  const statePaths = { state: paths.state, stateDir: paths.state };
  await saveRunState(statePaths, { destinations: { usb: { ...emptyDestinationState(), lastError: "x" } } });
  return { dir, paths, store, dest, statePaths, runState: fileRunStatePort(statePaths) };
}

describe("régressions : planification", () => {
  test("c459b58: destination injoignable puis rebranchée : sauvegarde immédiate, pas d'attente d'une heure", () => {
    // Injoignable : `waitingSince` et `lastAttempt`, jamais `lastFailure` (le moteur l'écrit ainsi).
    const state = { lastSuccess: at("2026-11-07T120500"), lastFailure: null };
    const base = { ...state, now: at("2026-11-08T150000"), running: false, power: AC_POWER, calendar: localCalendar };
    expect(decide(daily, { ...base, reachable: false })).toBe("waitingDestination");
    // Disque rebranché cinq minutes plus tard : décision `run` tout de suite.
    expect(decide(daily, { ...base, now: at("2026-11-08T150500"), reachable: true })).toBe("run");
  });

  test("7cc955d: un échec avant les destinations attend 3600 s ; un échec plus ancien que la réussite n'attend pas", () => {
    const base = {
      now: at("2026-11-08T150000"),
      running: false,
      power: AC_POWER,
      reachable: true,
      calendar: localCalendar,
    };
    const failure = at("2026-11-08T145959");
    expect(decide(daily, { ...base, lastSuccess: at("2026-11-07T120500"), lastFailure: failure })).toBe("retryLater");
    expect(decide(daily, { ...base, lastSuccess: null, lastFailure: at("2026-11-08T140001") })).toBe("retryLater");
    expect(decide(daily, { ...base, lastSuccess: null, lastFailure: at("2026-11-08T140000") })).toBe("run");
    expect(decide(daily, { ...base, lastSuccess: at("2026-11-07T120500"), lastFailure: at("2026-11-07T120000") })).toBe(
      "run",
    );
  });

  test("46a9475: la notice de retard relit runs.json avant d'écrire, sans écraser une sauvegarde concurrente", async () => {
    const dir = await tempDir();
    const paths = { state: path.join(dir, "state") };
    await saveRunState(paths, {
      destinations: {
        nas: { ...emptyDestinationState(), lastSuccess: at("2026-11-06T120500") },
        usb: { ...emptyDestinationState(), lastSuccess: at("2026-11-06T120500") },
      },
    });
    const real = fileRunStatePort(paths);
    // Une sauvegarde (`cairn backup`) écrit runs.json entre le début du tour et l'écriture de la notice.
    const racing: RunStatePort<ReturnType<typeof emptyDestinationState>> = {
      async update(mutate) {
        const s = await loadRunState(paths);
        s.destinations.usb = { ...s.destinations.usb!, lastSuccess: at("2026-11-08T175900"), lastBytesTransferred: 42 };
        await saveRunState(paths, s);
        await real.update(mutate);
      },
    };
    const notified: string[] = [];
    const input = {
      schedule: daily,
      waiting: { nas: true, usb: true },
      now: at("2026-11-08T180000"),
      calendar: localCalendar,
    };
    expect(await recordOverdueNotices(racing, input, (id) => notified.push(id))).toEqual(["nas"]);
    // Décision prise sur l'état relu : usb vient d'être sauvegardée, pas de notice.
    expect(notified).toEqual(["nas"]);
    const after = await loadRunState(paths);
    expect(after.destinations.usb?.lastSuccess).toEqual(at("2026-11-08T175900"));
    expect(after.destinations.usb?.lastBytesTransferred).toBe(42);
    expect(after.destinations.usb?.lastOverdueNotice).toBeUndefined();
    expect(after.destinations.nas?.lastOverdueNotice).toEqual(input.now);
  });
});

describe("régressions : destinations", () => {
  test("156f978: nettoyage strict des témoins, chemin vide refusé, image préférée respectée", async () => {
    const dir = await tempDir();
    const uuid = crypto.randomUUID();
    await writeFile(path.join(dir, WRITE_TEST_PREFIX + uuid), "cairn"); // témoin laissé par Cairn
    await writeFile(path.join(dir, `${WRITE_TEST_PREFIX}notes`), "cairn"); // pas d'UUID
    await writeFile(path.join(dir, WRITE_TEST_PREFIX + crypto.randomUUID()), "cairn\n"); // 6 octets
    await mkdir(path.join(dir, WRITE_TEST_PREFIX + crypto.randomUUID())); // dossier
    await checkFolder(dir, "Ce-Mac");
    expect(await exists(path.join(dir, WRITE_TEST_PREFIX + uuid))).toBe(false);
    expect((await readdir(dir)).length).toBe(3);

    expect(await checkFolder("", "Ce-Mac")).toEqual({ kind: "failed", failure: { kind: "notFound", path: "" } });

    const images = [
      "/nas/cairn-Autre-Mac.sparsebundle",
      "/nas/cairn-Ce-Mac.sparsebundle",
      "/nas/cairn-Vieux.sparsebundle",
    ];
    const preferred = "cairn-Vieux.sparsebundle";
    expect(chooseImage(images, { machine: "Ce-Mac", preferred, createIfMissing: false })).toBe(images[2]!);
    expect(chooseImage(images, { machine: "Ce-Mac", createIfMissing: false })).toBe(images[1]!);
    expect(chooseImage(images.slice(0, 1), { machine: "Ce-Mac", createIfMissing: false })).toBe(images[0]!);
    expect(chooseImage([], { machine: "Ce-Mac", createIfMissing: false })).toBeNull();
    expect(chooseImage(images.slice(0, 1), { machine: "Ce-Mac", createIfMissing: true })).toBe("create");
  });

  test("156f978: le Trousseau n'est écrit qu'après l'écriture réussie de config.toml", async () => {
    const dir = await tempDir();
    const store = new ConfigStore(new CairnPaths(dir));
    await store.save(defaultConfig());
    const writes: string[] = [];
    const verified = {
      provider: "smb" as const,
      url: "smb://syno/home/cairn",
      username: "romain",
      encrypted: true,
      retention: RECOMMENDED_RETENTION,
    };
    const saved = await saveNewDestination(store, verified, "secret", (d) => {
      writes.push(d.id);
    });
    expect(saved.destination.id).toBe("main");
    expect(writes).toEqual(["main"]);
    expect(await readFile(store.file, "utf8")).toContain('url = "smb://syno/home/cairn"');

    // Fichier corrigé à la main et encore invalide : enregistrement refusé, rien au Trousseau.
    await writeFile(store.file, '[schedule]\nweekday = "lundi"\n');
    const error = await saveNewDestination(store, verified, "secret", (d) => {
      writes.push(d.id);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigSaveError);
    expect(writes).toEqual(["main"]);
  });

  test("76e40ec: mot de passe vide à la modification : Trousseau inchangé, identité conservée", async () => {
    const dir = await tempDir();
    const store = new ConfigStore(new CairnPaths(dir));
    const c = defaultConfig();
    const original = destination("nas", "smb", { url: "smb://syno/backups", username: "romain", encrypted: true });
    c.destinations = [original];
    await store.save(c);
    const writes: string[] = [];
    const edited = destination("x", "smb", { url: "smb://syno/backups/mac", username: "romain", encrypted: false });
    const r = await saveEditedDestination(store, original, edited, "", () => void writes.push("x"));
    expect(writes).toEqual([]);
    expect(r.destination).toMatchObject({ id: "nas", encrypted: true, url: "smb://syno/backups/mac" });
    expect((await store.load()).config.destinations.map((d) => d.id)).toEqual(["nas"]);
  });
});

describe.skipIf(!nativeAvailable())("régressions : suppression d'une destination", () => {
  let saved: NativeBinding | null = null;
  afterEach(() => {
    if (saved) setNative(saved);
    saved = null;
  });

  /** Module natif réel, avec les accès au Trousseau comptés (et refusés). */
  function spyKeychain(): string[] {
    const real = native();
    saved = real;
    const calls: string[] = [];
    const deny = (name: string) => () => {
      calls.push(name);
      throw new Error(`keychain access ${name}`);
    };
    setNative({
      ...real,
      keychainGetGeneric: deny("getGeneric"),
      keychainSetGeneric: deny("setGeneric"),
      keychainGetInternet: deny("getInternet"),
      keychainSetInternet: deny("setInternet"),
    });
    return calls;
  }

  test("76e40ec: la suppression ne touche jamais au Trousseau ; configuration, sauvegardes puis état", async () => {
    const f = await fixture();
    const calls = spyKeychain();
    const plan = await planRemoval((await f.store.load()).config.destinations[1]!, true, { machine: "Ce-Mac" });
    await removeDestination(plan, { store: f.store, paths: f.statePaths, runState: f.runState });
    expect(calls).toEqual([]);
    expect((await f.store.load()).config.destinations.map((d) => d.id)).toEqual(["main"]);
    expect(await exists(path.join(f.dest, "cairn-Ce-Mac.sparsebundle"))).toBe(false);
    expect((await loadRunState(f.statePaths)).destinations).toEqual({});
  });

  test("76e40ec: écriture de la configuration refusée : rien n'est supprimé", async () => {
    const f = await fixture();
    const plan = await planRemoval((await f.store.load()).config.destinations[1]!, true, { machine: "Ce-Mac" });
    const text = await readFile(f.store.file, "utf8");
    // Corrigé à la main et encore invalide : `save` refuse d'écraser le fichier.
    expect(text).toContain('weekday = "monday"');
    await writeFile(f.store.file, text.replace('weekday = "monday"', 'weekday = "lundi"'));
    const error = await removeDestination(plan, { store: f.store, paths: f.statePaths, runState: f.runState }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigSaveError);
    expect(await exists(path.join(f.dest, "cairn-Ce-Mac.sparsebundle"))).toBe(true);
    expect(Object.keys((await loadRunState(f.statePaths)).destinations)).toEqual(["usb"]);
  });

  test("76e40ec: suppression des sauvegardes en échec : l'entrée est remise à sa place", async () => {
    const f = await fixture();
    const d = (await f.store.load()).config.destinations[1]!;
    const plan = await planRemoval(d, true, { machine: "Ce-Mac" });
    // La destination disparaît entre la simulation et l'exécution (disque débranché).
    const failing = () => {
      const p = new LocalProvider(d);
      p.prepare = async () => {
        throw new Error("disk unplugged");
      };
      return p;
    };
    const error = await removeDestination(plan, {
      store: f.store,
      paths: f.statePaths,
      runState: f.runState,
      provider: failing,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((await f.store.load()).config.destinations.map((x) => x.id)).toEqual(["main", "usb"]);
    expect(await exists(path.join(f.dest, "cairn-Ce-Mac.sparsebundle"))).toBe(true);
    expect(Object.keys((await loadRunState(f.statePaths)).destinations)).toEqual(["usb"]);
  });
});

describe("régressions : partages SMB", () => {
  test("0547a02: smb://hôte liste les partages, mot de passe sur stdin et jamais en argument", async () => {
    const calls: Array<{ args: readonly string[]; stdin: unknown }> = [];
    const output = "Share        Type    Comments\n-------\nhome         Disk\nIPC$         Pipe\n";
    const fakeRun = async (_exe: string, args: readonly string[], options: { stdin?: unknown } = {}) => {
      calls.push({ args, stdin: options.stdin });
      return processResult(0, output);
    };
    const deps = {
      reachable: async () => true,
      run: fakeRun as never,
      secrets: { internetPassword: async () => null },
    };
    expect(await listShares("syno", "romain", "s3cret", deps)).toEqual({ ok: true, value: ["home"] });
    expect(calls[0]!.args).toEqual(["view", "-f", "//romain@syno"]);
    expect(calls[0]!.stdin).toBe("s3cret\n");
    expect(calls[0]!.args.join(" ")).not.toContain("s3cret");
    // Sans mot de passe ni Trousseau : -N, rien sur stdin.
    expect(await listShares("syno", "romain", null, deps)).toEqual({ ok: true, value: ["home"] });
    expect(calls[1]!.args).toEqual(["view", "-f", "-N", "//romain@syno"]);
    expect(calls[1]!.stdin).toBeUndefined();
  });

  test("0547a02: erreurs de smbutil : authentification, mot de passe requis, aucun partage", async () => {
    const reply = (r: ProcessResult) => ({
      reachable: async () => true,
      run: (async () => r) as never,
      secrets: { internetPassword: async () => null },
    });
    const auth = processResult(77, "", ["smbutil: server rejected the authentication"]);
    expect(await listShares("syno", "romain", "pw", reply(auth))).toEqual({
      ok: false,
      failure: { kind: "authenticationFailed" },
    });
    expect(await listShares("syno", "romain", null, reply(auth))).toEqual({
      ok: false,
      failure: { kind: "passwordRequired" },
    });
    expect(await listShares("syno", "romain", "pw", reply(processResult(0, "nothing")))).toEqual({
      ok: false,
      failure: { kind: "notFound", path: "smb://syno" },
    });
    const down = { ...reply(auth), reachable: async () => false };
    expect(await listShares("syno", "romain", "pw", down)).toEqual({
      ok: false,
      failure: { kind: "unreachable", host: "syno" },
    });
  });

  test("0547a02: vrai smbutil sur un hôte .invalid : injoignable, pas une erreur d'authentification", async () => {
    // La sonde TCP est contournée pour atteindre smbutil ; aucun mot de passe, aucun Trousseau.
    const r = await listShares("cairn-test.invalid", "cairn", null, {
      reachable: async () => true,
      secrets: { internetPassword: async () => null },
    });
    expect(r).toEqual({ ok: false, failure: { kind: "unreachable", host: "cairn-test.invalid" } });
  });

  test("leçon « boutons » : une action indisponible donne sa raison", () => {
    const c = { reachable: true, backingUp: false, verifying: false, hasBackups: false };
    expect(unavailableReason("verify", c)).toBe("backup.unavailable.nothing_to_verify");
    expect(unavailableReason("backup", { ...c, reachable: false })).toBe("backup.unavailable.unreachable");
  });
});
