// Process principal (groupe 10) : état poussé à l'interface, validation des appels IPC, sauvegarde simulée lancée par
// `window.cairn`, barre des menus, et régression 0f7a1ce (l'installation d'une mise à jour redevient possible dès la
// fin de la sauvegarde). Toujours un CAIRN_HOME temporaire, des dossiers temporaires et une simulation (`dryRun`).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import type { AppSnapshot, CairnApi } from "../../src/shared/contract.ts";
import { desktopRoot, temporaryHome } from "./helpers.ts";

type WithCairn = { cairn: CairnApi; __snaps: AppSnapshot[] };

async function launch(home: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  return electron.launch({
    args: [desktopRoot],
    cwd: desktopRoot,
    env: {
      ...env,
      CAIRN_HOME: home,
      CAIRN_E2E_USER_DATA: path.join(home, ".electron"),
      CAIRN_TOOLS_INVENTORY: "empty",
      CAIRN_UPDATE_URL: "http://127.0.0.1:9/none",
      ...extraEnv,
    },
  });
}

async function mainWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow();
  await expect(window.getByTestId("app-root")).toBeAttached();
  return window;
}

/** Enregistre chaque état reçu dans `window.__snaps`. */
async function recordSnapshots(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as WithCairn;
    w.__snaps = [];
    w.cairn.subscribe((s) => w.__snaps.push(s));
  });
}

/** Configuration valide : un dossier suivi et une destination locale non chiffrée, planification manuelle. */
async function configuredHome(
  folders = 1,
  options: { dest?: string; frequency?: string } = {},
): Promise<{ home: string; source: string; dest: string }> {
  const home = await temporaryHome();
  const source = path.join(home, "work");
  const dest = options.dest ?? path.join(home, "backup-dest");
  // Plusieurs dossiers du premier niveau : la simulation dure assez pour montrer sa progression.
  for (let d = 0; d < folders; d++) {
    const dir = path.join(source, `project-${d}/src`);
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => writeFile(path.join(dir, `f${i}.txt`), `file ${i}\n`.repeat(50))),
    );
  }
  await writeFile(path.join(source, "README.md"), "hello\n");
  if (!options.dest) await mkdir(dest, { recursive: true });
  await writeFile(
    path.join(home, "config.toml"),
    `version = 1
language = "en-US"

[[folders]]
path = "${source}"
backup = true
exclude = []

[home]
include = []
exclude = []

[[destinations]]
id = "local"
provider = "local"
path = "${dest}"
encrypted = false
retention = { mode = "count", count = 3 }

[schedule]
frequency = "${options.frequency ?? "manual"}"
time = "12:30"
weekday = "monday"
background = false
on_battery_min_percent = 20

[updates]
check = false
`,
  );
  return { home, source, dest };
}

test("premier lancement : un CAIRN_HOME vide donne l'état « premier lancement »", async () => {
  const app = await launch(await temporaryHome());
  const window = await mainWindow(app);
  const snapshot = await window.evaluate(() => (window as unknown as WithCairn).cairn.getSnapshot());
  expect(snapshot.contract).toBe(1);
  expect(snapshot.firstLaunch).toBe(true);
  expect(snapshot.config.exists).toBe(false);
  expect(snapshot.destinations).toEqual([]);
  expect(snapshot.backup.running).toBe(false);
  expect(snapshot.hub.modules.length).toBe(5);
  expect(snapshot.restore.available).toBe(true);
  expect(snapshot.restore.running).toBe(false);
  // Le premier état arrive aussi par l'abonnement.
  const pushed = await window.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const off = (window as unknown as WithCairn).cairn.subscribe((s) => {
          queueMicrotask(() => off());
          resolve(s.revision);
        });
      }),
  );
  expect(pushed).toBeGreaterThan(0);
  await app.close();
});

test("un appel IPC aux arguments invalides est refusé avant d'atteindre le core", async () => {
  const app = await launch(await temporaryHome());
  const window = await mainWindow(app);
  const errors = await window.evaluate(async () => {
    const api = (window as unknown as WithCairn).cairn as unknown as Record<string, (a?: unknown) => Promise<unknown>>;
    const attempt = async (name: string, args?: unknown) => {
      try {
        await api[name]!(args);
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    };
    return {
      wrongType: await attempt("startBackup", { destinations: 42 }),
      unknownKey: await attempt("startBackup", { dryRun: true, shell: "rm -rf ~" }),
      freePath: await attempt("removeNodes", { nodeIds: ["/Users"] }),
      relativePath: await attempt("listFolders", { path: "../.." }),
      badUrl: await attempt("openExternal", { url: "javascript:alert(1)" }),
      notAllowed: await attempt("openExternal", { url: "https://example.com/" }),
      unknownNode: await attempt("removeNodes", { nodeIds: [123456] }),
      noArgs: await attempt("scan"),
    };
  });
  expect(errors.wrongType).toMatch(/^.*cairn:invalidArguments:invalid arguments for startBackup: destinations/);
  expect(errors.unknownKey).toMatch(/cairn:invalidArguments:/);
  expect(errors.freePath).toMatch(/cairn:invalidArguments:.*nodeIds/);
  expect(errors.relativePath).toMatch(/cairn:invalidArguments:.*path/);
  expect(errors.badUrl).toMatch(/cairn:invalidArguments:/);
  // Arguments valides mais refusés par le main : liste blanche, nœud inconnu.
  expect(errors.notAllowed).toMatch(/cairn:forbidden:/);
  expect(errors.unknownNode).toMatch(/cairn:notFound:/);
  expect(errors.noArgs).toMatch(/cairn:invalidArguments:/);
  // Le preload n'expose que l'API métier.
  const exposed = await window.evaluate(() => Object.keys((window as unknown as WithCairn).cairn).sort());
  expect(exposed).toContain("startBackup");
  expect(exposed).not.toContain("invoke");
  expect(exposed).not.toContain("ipcRenderer");
  await app.close();
});

test("une seule confirmation : le jeton de la feuille évite la boîte du main, sans jeton elle décide", async () => {
  const { home } = await configuredHome();
  // La boîte native répond « Annuler » : seul un jeton valide laisse l'action se faire.
  const app = await launch(home, { CAIRN_E2E_CONFIRM: "no" });
  const window = await mainWindow(app);
  const result = await window.evaluate(async () => {
    const api = (window as unknown as WithCairn).cairn;
    const without = await api.removeDestination({
      planId: (await api.planDestinationRemoval({ id: "local", includeBackups: false })).planId,
    });
    const plan = await api.planDestinationRemoval({ id: "local", includeBackups: false });
    // Jeton préparé pour d'autres arguments : refusé, la boîte du main répond « Annuler ».
    const other = await api.prepareConfirmation({ method: "removeDestination", args: { planId: "autre-plan" } });
    const wrong = await api.removeDestination({ planId: plan.planId, confirmation: other.token });
    const good = await api.prepareConfirmation({ method: "removeDestination", args: { planId: plan.planId } });
    const confirmed = await api.removeDestination({ planId: plan.planId, confirmation: good.token });
    const snapshot = await api.getSnapshot();
    return { without, wrong, confirmed, destinations: snapshot.destinations.length };
  });
  expect(result.without).toEqual({ cancelled: true });
  expect(result.wrong).toEqual({ cancelled: true });
  expect(result.confirmed).toEqual({ cancelled: false });
  expect(result.destinations).toBe(0);
  await app.close();
});

test("startBackup en simulation : progression poussée puis fin, rien d'écrit sur la destination", async () => {
  const { home, dest } = await configuredHome(30);
  const app = await launch(home);
  const window = await mainWindow(app);
  await expect
    .poll(() =>
      window.evaluate(() => (window as unknown as WithCairn).cairn.getSnapshot().then((s) => s.config.exists)),
    )
    .toBe(true);
  // La barre des menus existe dès le démarrage.
  const tray = await app.evaluate(() =>
    (globalThis as unknown as { __cairnTest: { tray(): string | null } }).__cairnTest.tray(),
  );
  expect(["normal", "attention", "error"]).toContain(tray);

  await recordSnapshots(window);
  await window.evaluate(() =>
    (window as unknown as WithCairn).cairn.startBackup({ destinations: ["local"], dryRun: true, only: ["folder"] }),
  );
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const snaps = (window as unknown as WithCairn).__snaps;
          const last = snaps.at(-1);
          return last ? !last.backup.running && last.backup.finishedAt !== null : false;
        }),
      { timeout: 45_000 },
    )
    .toBe(true);
  const summary = await window.evaluate(() => {
    const snaps = (window as unknown as WithCairn).__snaps;
    const phases = new Set<string>();
    for (const s of snaps) for (const d of s.backup.destinations) phases.add(d.phase);
    const last = snaps.at(-1)!;
    return {
      sawRunning: snaps.some((s) => s.backup.running),
      phases: [...phases],
      dryRun: last.backup.dryRun,
      result: last.backup.destinations.find((d) => d.destination === "local")?.result?.status ?? null,
      lastError: last.backup.lastError,
      revisions: snaps.map((s) => s.revision),
    };
  });
  expect(summary.sawRunning).toBe(true);
  expect(summary.dryRun).toBe(true);
  expect(summary.lastError).toBeNull();
  expect(summary.result).toBe("succeeded");
  expect(summary.phases).toContain("done");
  expect(summary.phases.some((p) => ["preparing", "counting", "copying"].includes(p))).toBe(true);
  // Instantanés dans l'ordre, sans doublon.
  expect([...summary.revisions].sort((a, b) => a - b)).toEqual(summary.revisions);
  // Une simulation n'écrit rien sur la destination.
  expect(await readdir(dest)).toEqual([]);
  await app.close();
});

test("0f7a1ce : l'installation d'une mise à jour redevient possible dès la fin de la sauvegarde", async () => {
  const { home } = await configuredHome();
  const server: Server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === "/latest") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tag_name: "v99.0.0",
          draft: false,
          prerelease: false,
          html_url: "https://github.com/Romakita/cairn/releases/tag/v99.0.0",
          body: "notes",
          assets: ["arm64", "x86_64"].flatMap((a) => [
            { name: `Cairn-99.0.0-${a}.zip`, browser_download_url: `${base}/Cairn-99.0.0-${a}.zip` },
            { name: `Cairn-99.0.0-${a}.zip.sha256`, browser_download_url: `${base}/Cairn-99.0.0-${a}.zip.sha256` },
          ]),
        }),
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const app = await launch(home, { CAIRN_UPDATE_URL: `http://127.0.0.1:${port}/latest` });
    const window = await mainWindow(app);
    await window.evaluate(() => (window as unknown as WithCairn).cairn.checkUpdates());
    await expect
      .poll(() =>
        window.evaluate(() =>
          (window as unknown as WithCairn).cairn.getSnapshot().then((s) => s.updates.available?.version ?? null),
        ),
      )
      .toBe("99.0.0");
    const locales = await Promise.all(
      ["en", "fr"].map(async (l) => JSON.parse(await readFile(path.join(desktopRoot, `locales/${l}.json`), "utf8"))),
    );
    const blockedByBackup = locales.map((c) => c["update.blocked.backup"] as string);

    await recordSnapshots(window);
    await window.evaluate(() =>
      (window as unknown as WithCairn).cairn.startBackup({ destinations: ["local"], dryRun: true, only: ["folder"] }),
    );
    await expect
      .poll(
        () =>
          window.evaluate(() => {
            const last = (window as unknown as WithCairn).__snaps.at(-1);
            return last ? !last.backup.running && last.backup.finishedAt !== null : false;
          }),
        { timeout: 45_000 },
      )
      .toBe(true);
    const states = await window.evaluate(() =>
      (window as unknown as WithCairn).__snaps.map((s) => ({ running: s.backup.running, blocker: s.updates.blocker })),
    );
    const during = states.filter((s) => s.running);
    expect(during.length).toBeGreaterThan(0);
    for (const s of during) expect(blockedByBackup).toContain(s.blocker);
    // Dernier état (fin de la sauvegarde) : plus bloqué par la sauvegarde, sans autre événement.
    const after = states.at(-1)!;
    expect(after.running).toBe(false);
    expect(blockedByBackup).not.toContain(after.blocker);
    await app.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("barre des menus : icône selon l'état et panneau avec le même preload", async () => {
  const app = await launch(await temporaryHome());
  await mainWindow(app);
  type Hooks = { __cairnTest: { tray(): string | null; showPanel(): void; panelExists(): boolean } };
  expect(await app.evaluate(() => (globalThis as unknown as Hooks).__cairnTest.tray())).toBe("normal");
  await app.evaluate(() => (globalThis as unknown as Hooks).__cairnTest.showPanel());
  const panel = await app.waitForEvent("window", { predicate: (p) => p.url().includes("#/menubar") });
  await expect(panel.getByTestId("app-root")).toBeAttached();
  const hasApi = await panel.evaluate(() => typeof (window as unknown as WithCairn).cairn?.getSnapshot === "function");
  expect(hasApi).toBe(true);
  await app.close();
});

type Hooks = { __cairnTest: { tick(): Promise<void> } };

/** Attend la fin de la sauvegarde en cours (dernier état reçu). */
async function backupFinished(window: Page): Promise<void> {
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const last = (window as unknown as WithCairn).__snaps.at(-1);
          return last ? !last.backup.running && last.backup.finishedAt !== null : false;
        }),
      { timeout: 45_000 },
    )
    .toBe(true);
}

test("planificateur : joignabilité et attente d'une destination absente, sans sauvegarde lancée", async () => {
  const { home } = await configuredHome(1, { dest: "/Volumes/cairn-e2e-absent-volume/backups", frequency: "daily" });
  const app = await launch(home);
  const window = await mainWindow(app);
  await app.evaluate(() => (globalThis as unknown as Hooks).__cairnTest.tick());
  const s = await window.evaluate(() => (window as unknown as WithCairn).cairn.getSnapshot());
  const d = s.destinations.find((x) => x.id === "local")!;
  expect(d.reachable).toBe(false);
  expect(d.waiting).toBe(true);
  expect(d.unavailable.backup).toBe("backup.unavailable.unreachable");
  // Les tests ne lancent jamais de sauvegarde planifiée.
  expect(s.backup.running).toBe(false);
  expect(s.backup.startedAt).toBeNull();
  await app.close();
});

test("veille pendant une sauvegarde : suspendue puis reprise, elle se termine", async () => {
  const { home } = await configuredHome(30);
  const app = await launch(home);
  const window = await mainWindow(app);
  await recordSnapshots(window);
  await window.evaluate(() =>
    (window as unknown as WithCairn).cairn.startBackup({ destinations: ["local"], dryRun: true, only: ["folder"] }),
  );
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("suspend");
  });
  await new Promise((r) => setTimeout(r, 500));
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("resume");
  });
  await backupFinished(window);
  const last = await window.evaluate(() => (window as unknown as WithCairn).__snaps.at(-1)!);
  expect(last.backup.destinations.find((d) => d.destination === "local")?.result?.status).toBe("succeeded");
  await app.close();
});

test("fermeture pendant une sauvegarde : arrêt propre, le verrou est rendu", async () => {
  const { home } = await configuredHome(30);
  const first = await launch(home);
  const window = await mainWindow(first);
  await window.evaluate(() =>
    (window as unknown as WithCairn).cairn.startBackup({ destinations: ["local"], dryRun: true, only: ["folder"] }),
  );
  const started = Date.now();
  await first.close();
  // Arrêt en moins de 5 s d'attente (plus le temps de fermeture d'Electron).
  expect(Date.now() - started).toBeLessThan(15_000);
  // Une nouvelle instance peut relancer aussitôt : le verrou d'opération est libre.
  const second = await launch(home);
  const w2 = await mainWindow(second);
  const lock = await w2.evaluate(() => (window as unknown as WithCairn).cairn.getSnapshot().then((s) => s.lock.held));
  expect(lock).toBe(false);
  await recordSnapshots(w2);
  await w2.evaluate(() =>
    (window as unknown as WithCairn).cairn.startBackup({ destinations: ["local"], dryRun: true, only: ["folder"] }),
  );
  await backupFinished(w2);
  await second.close();
});
