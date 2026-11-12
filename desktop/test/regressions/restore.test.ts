// Régressions de la restauration (parity/behavior.md §2) : un test par commit corrigé dans la 0.8.0, plus les règles
// de sécurité (verrou, Terminal, volume). Rien n'est installé, Terminal, osascript et diskutil ne sont jamais lancés.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { DestinationSession } from "../../src/core/backup/session.ts";
import { ProviderError } from "../../src/core/backup/types.ts";
import { destination } from "../../src/core/config.ts";
import { OperationLock, OperationLockError } from "../../src/core/lock.ts";
import {
  chooseVersion,
  commandProbe,
  createWorkspacesVolume,
  defaultPlan,
  defaultVersion,
  emptyReport,
  folderTarget,
  HOMEBREW_INSTALL,
  openForRestore,
  openRestoreSource,
  partOfWhole,
  QUIT_POLL_MS,
  QUIT_TIMEOUT_MS,
  type RestoreEvent,
  RestoreService,
  type RestoreSource,
  type RestoreVersion,
  restoreDatabase,
  rewriteClaudeProjects,
  targetIsMissing,
  terminalAdminWaiter,
  terminalScript,
  waitUntilQuit,
} from "../../src/core/restore/index.ts";
import { withTempDir } from "../helpers/backup-env.ts";
import { nativeAvailable } from "../helpers/native.ts";
import {
  cltRunner,
  FakeClock,
  legacyBackup,
  legacyBackupWithAI,
  put,
  recordingRunner,
} from "../helpers/restore-fixtures.ts";

const native = nativeAvailable();

async function open(dir: string): Promise<RestoreSource> {
  const s = await openRestoreSource(dir);
  if (!s) throw new Error(`not a backup: ${dir}`);
  return s;
}

const v = (machine: string, version: string, partial = false): RestoreVersion => ({
  machine,
  version,
  path: `/d/${machine}/${version}`,
  partial,
});

describe("restore regressions", () => {
  test("46a9475_default_version_sorted_by_name_this_mac_first_and_no_fallback", () => {
    const all = [v("Alpha", "2026-11-01T120000"), v("Beta", "2026-11-03T120000", true), v("Zulu", "2025-01-01T120000")];
    expect(defaultVersion(all, "New")).toBe("/d/Alpha/2026-11-01T120000"); // pas la dernière de la liste
    expect(defaultVersion(all, "Zulu")).toBe("/d/Zulu/2025-01-01T120000"); // ce Mac d'abord
    expect(defaultVersion([v("Beta", "2026-11-03T120000", true)], "New")).toBe("/d/Beta/2026-11-03T120000");
    expect(defaultVersion([], "New")).toBeNull();
    // --version X : absente → erreur d'usage, jamais de repli sur une autre version.
    expect(chooseVersion(all, "New", "2024-01-01T000000")).toEqual({ error: "unknownVersion" });
    expect(chooseVersion(all, "New", "2025-01-01T120000")).toEqual({ path: "/d/Zulu/2025-01-01T120000" });
    expect(chooseVersion([], "New")).toEqual({ error: "noVersion" });
  });

  test("46a9475_tool_name_is_a_positional_argument_never_shell_code", () => {
    expect(commandProbe("x; rm -rf ~")).toEqual(["/bin/sh", "-c", 'command -v -- "$1"', "sh", "x; rm -rf ~"]);
  });

  test("3692993_partial_version_is_not_the_default", () => {
    const all = [v("m", "2026-11-01T120000"), v("m", "2026-11-05T120000", true)];
    expect(defaultVersion(all, "m")).toBe("/d/m/2026-11-01T120000");
  });

  test("a version chosen in the list is restored from its own machine, even with the same name elsewhere", () => {
    const all = [v("m", "2026-11-01T120000"), v("old", "2026-11-01T120000")];
    expect(chooseVersion(all, "m", "2026-11-01T120000", "old")).toEqual({ path: "/d/old/2026-11-01T120000" });
    expect(chooseVersion(all, "m", "2026-11-01T120000", "m")).toEqual({ path: "/d/m/2026-11-01T120000" });
    // Sans machine (`cairn restore --version`) : celle de ce Mac d'abord, comme avant.
    expect(chooseVersion(all, "m", "2026-11-01T120000")).toEqual({ path: "/d/m/2026-11-01T120000" });
    expect(chooseVersion(all, "m", "2026-11-01T120000", "ailleurs")).toEqual({ error: "unknownVersion" });
  });

  test("a backed-up folder named constructor or __proto__ is never selected by default", async () => {
    const plan = defaultPlan();
    for (const name of ["constructor", "toString", "__proto__"]) expect(folderTarget(plan, name)).toBeUndefined();
    const proto = "__proto__"; // nom de dossier possible : une propriété propre, jamais le prototype
    plan.folders[proto] = "/tmp/x";
    expect(folderTarget(plan, proto)).toBe("/tmp/x");
    expect(folderTarget(defaultPlan(), "__proto__")).toBeUndefined();
    await withTempDir(async (dir) => {
      const source = await open(legacyBackup(dir));
      source.folders.push({ name: "constructor", originalPath: "/x/constructor", dir: path.join(dir, "constructor") });
      const service = new RestoreService(source, { home: path.join(dir, "home"), runner: recordingRunner().run });
      const res = await service.run(defaultPlan());
      expect(res.filter((s) => !s.ok)).toEqual([]);
      expect(res.some((s) => s.step === "folders/constructor")).toBe(false);
    });
  });

  test("e229e52_simulation_creates_no_target", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const target = path.join(dir, "new/ws");
      const service = new RestoreService(await open(legacyBackup(dir)), { home, runner: recordingRunner().run });
      const res = await service.run({ ...defaultPlan(), folders: { workspaces: target }, ai: ["codex"] });
      expect(res.filter((s) => !s.ok)).toEqual([]);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(path.join(dir, "new"))).toBe(false);
      expect(existsSync(home)).toBe(false); // ni le home
      // Simulation : aucune installation lancée, rien ouvert dans Terminal.
      const runner = cltRunner(false);
      const asked: string[] = [];
      await new RestoreService(await open(legacyBackup(dir)), {
        home,
        runner: runner.run,
        waitForAdmin: async (c) => {
          asked.push(c);
          return true;
        },
      }).run(defaultPlan());
      expect(asked).toEqual([]);
      expect(runner.commands.every((c) => c[0] === "/bin/sh" || c[0] === "/usr/bin/xcode-select")).toBe(true);
    });
  });

  test("3692993_restore_never_creates_a_destination", async () => {
    await withTempDir(async (dir) => {
      const dest = path.join(dir, "absent");
      const session = new DestinationSession(destination("d", "local", { path: dest, encrypted: false }), {
        secrets: new MemorySecrets(),
        machine: "m",
      });
      const error = await openForRestore(session, async () => null).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).reason).toBe("notCreated");
      expect(existsSync(dest)).toBe(false);
    });
  });

  test("3692993_passwords_are_asked_on_a_new_mac", async () => {
    // Mac neuf : Trousseau vide, le partage puis l'image demandent leur mot de passe, une fois chacun.
    const asked: string[] = [];
    const calls: string[] = [];
    const pw: { share: string | null; image: string | null } = { share: null, image: null };
    const fake = {
      set sharePassword(p: string | null) {
        pw.share = p;
      },
      get imagePassword() {
        return pw.image;
      },
      set imagePassword(p: string | null) {
        pw.image = p;
      },
      async open(create: boolean) {
        calls.push(`open:${create}`);
        if (pw.share === null) throw ProviderError.missingPassword("nas");
        if (pw.image === null) throw ProviderError.missingImagePassword("/m/cairn-old.sparsebundle");
        return "/nonexistent-cairn-root";
      },
      async close() {
        calls.push("close");
      },
    } as unknown as DestinationSession;
    const opened = await openForRestore(fake, async (kind) => {
      asked.push(kind);
      return `${kind}-pw`;
    });
    expect(asked).toEqual(["share", "image"]);
    expect(calls).toEqual(["open:false", "open:false", "close", "open:false"]); // jamais de création
    expect(opened).toEqual({ root: "/nonexistent-cairn-root", versions: [] });
    expect(pw).toEqual({ share: "share-pw", image: "image-pw" });
    // Abandon de la saisie : rien n'est ouvert.
    pw.share = null;
    pw.image = null;
    expect(await openForRestore(fake, async () => null)).toBeNull();
  });

  test.skipIf(!native)("3692993_legacy_home_leaves_ai_folders_to_the_merge", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const service = new RestoreService(await open(legacyBackupWithAI(dir)), {
        home,
        runner: recordingRunner().run,
        statePaths: { stateDir: path.join(dir, "state") },
      });
      await service.run({ ...defaultPlan(), tools: false, ai: [] }, { apply: true });
      expect(readdirSync(home).sort()).toEqual([".zshrc"]);
    });
  });

  test("3692993_open_ai_tool_is_polled_every_2s_for_10_minutes", async () => {
    const codex = { id: "codex", processes: ["codex"] } as never;
    const clock = new FakeClock();
    expect(await waitUntilQuit(codex, { isRunning: async () => true, clock })).toBe(false);
    expect(clock.current).toBe(QUIT_TIMEOUT_MS);
    expect(new Set(clock.sleeps)).toEqual(new Set([QUIT_POLL_MS]));
    expect(clock.sleeps).toHaveLength(QUIT_TIMEOUT_MS / QUIT_POLL_MS);
    let polls = 0;
    const quitting = new FakeClock();
    expect(await waitUntilQuit(codex, { isRunning: async () => ++polls < 3, clock: quitting })).toBe(true);
    expect(quitting.current).toBe(2 * QUIT_POLL_MS);
  });

  test.skipIf(!native)("3692993_open_ai_tool_is_announced_to_the_interface", async () => {
    await withTempDir(async (dir) => {
      const service = new RestoreService(await open(legacyBackup(dir)), {
        home: path.join(dir, "home"),
        statePaths: { stateDir: path.join(dir, "state") },
        isRunning: async () => true,
        waitForQuit: async () => true,
      });
      const events: RestoreEvent[] = [];
      service.on((e) => events.push(e));
      await service.run({ ...defaultPlan(), tools: false, home: false, ai: ["codex"] }, { apply: true });
      const waits = events.flatMap((e) => (e.type === "progress" && e.progress.waiting ? [e.progress.waiting] : []));
      expect(waits[0]).toEqual({ kind: "quit", tool: "codex", name: "Codex" });
      const last = events.at(-1)!;
      expect(last.type).toBe("finished");
      // Progression sérialisable (IPC) : un aller-retour JSON la garde telle quelle.
      const progress = service.currentProgress!;
      expect(JSON.parse(JSON.stringify(progress))).toEqual(progress);
      expect(progress).toMatchObject({ finished: true, done: progress.total, waiting: null });
    });
  });

  test("01538a8_existing_database_only_replaced_on_request_with_its_wal", async () => {
    await withTempDir(async (dir) => {
      const snap = path.join(dir, "snap.sqlite");
      put("snap", snap);
      const db = path.join(dir, "home/state.sqlite");
      put("local", db);
      put("wal", `${db}-wal`);
      put("shm", `${db}-shm`);
      expect(await restoreDatabase(snap, db, false)).toBe(false);
      expect(readFileSync(db, "utf8")).toBe("local");
      expect(await restoreDatabase(snap, db, true)).toBe(true);
      expect(readFileSync(db, "utf8")).toBe("snap");
      expect(readFileSync(`${db}.pre-restore`, "utf8")).toBe("local");
      expect(readFileSync(`${db}.pre-restore-wal`, "utf8")).toBe("wal");
      expect(readFileSync(`${db}.pre-restore-shm`, "utf8")).toBe("shm");
      expect(existsSync(`${db}-wal`)).toBe(false);
      expect(existsSync(`${db}-shm`)).toBe(false);
    });
  });

  test("01538a8_project_folder_removed_only_after_a_complete_merge_longest_prefix_first", async () => {
    await withTempDir(async (dir) => {
      const projects = path.join(dir, "projects");
      put("a", path.join(projects, "-Users-old-ws-app/a.jsonl"));
      put("b", path.join(projects, "-Volumes-ws-app/b.jsonl")); // cible existante : fusion
      const report = emptyReport();
      await rewriteClaudeProjects(
        projects,
        [
          ["/Users/old", "/Users/new"],
          ["/Users/old/ws", "/Volumes/ws"],
        ],
        report,
      );
      expect(report.renamedProjects).toEqual(["-Volumes-ws-app"]);
      expect(readdirSync(projects)).toEqual(["-Volumes-ws-app"]); // ancien dossier supprimé après la fusion
      expect(readdirSync(path.join(projects, "-Volumes-ws-app")).sort()).toEqual(["a.jsonl", "b.jsonl"]);
    });
  });

  test("RestoreWarningTests_missing_target_checks_the_volume_itself", async () => {
    const volumes = (p: string) => p === "/Volumes" || p === "/";
    expect(await targetIsMissing("/Volumes/workspaces/projets", volumes)).toBe(true);
    expect(await targetIsMissing("/Volumes/", volumes)).toBe(false); // parent « / »
    expect(await targetIsMissing("~/ws", () => true)).toBe(false);
  });

  test("terminal_command_is_escaped_for_applescript", () => {
    expect(terminalScript(HOMEBREW_INSTALL)).toEqual([
      "-e",
      'tell application "Terminal" to do script "/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\""',
      "-e",
      'tell application "Terminal" to activate',
    ]);
    expect(terminalScript('a\\b"c')[1]).toBe('tell application "Terminal" to do script "a\\\\b\\"c"');
  });

  test("admin_step_opens_terminal_then_waits_for_brew", async () => {
    const scripts: string[][] = [];
    const clock = new FakeClock();
    let checks = 0;
    const wait = terminalAdminWaiter({
      runner: recordingRunner().run,
      clock,
      osascript: async (args) => {
        scripts.push([...args]);
      },
      isExecutable: async (p) => p === "/opt/homebrew/bin/brew" && ++checks > 2,
    });
    expect(await wait(HOMEBREW_INSTALL)).toBe(true);
    expect(scripts).toEqual([terminalScript(HOMEBREW_INSTALL)]);
    expect(clock.current).toBe(2 * 5000);
    // Command Line Tools : attente de `xcode-select -p` (1 h au plus).
    const never = new FakeClock();
    const clt = terminalAdminWaiter({ runner: cltRunner(false).run, clock: never, osascript: async () => {} });
    expect(await clt("xcode-select --install")).toBe(false);
    expect(never.current).toBe(3_600_000);
  });

  test("workspaces_volume_is_created_only_by_its_own_function", async () => {
    const calls: string[][] = [];
    const diskutil = async (args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "info"
        ? { status: 0, output: "   Device Node:  /dev/disk3s1\n   Part of Whole:             disk3\n" }
        : { status: 0, output: "Created" };
    };
    expect(await createWorkspacesVolume(diskutil)).toEqual({ ok: true, output: "Created" });
    expect(calls).toEqual([
      ["info", "/"],
      ["apfs", "addVolume", "disk3", "APFS", "workspaces"],
    ]);
    expect(partOfWhole("nothing here")).toBeNull();
    const none: string[][] = [];
    const r = await createWorkspacesVolume(async (args) => {
      none.push([...args]);
      return { status: 0, output: "no container" };
    });
    expect(r.ok).toBe(false);
    expect(none).toEqual([["info", "/"]]); // sans conteneur : aucun volume ajouté
  });

  test.skipIf(!native)("restore_apply_takes_the_operation_lock", async () => {
    await withTempDir(async (dir) => {
      const statePaths = { stateDir: path.join(dir, "state") };
      mkdirSync(statePaths.stateDir);
      const service = new RestoreService(await open(legacyBackup(dir)), {
        home: path.join(dir, "home"),
        runner: recordingRunner().run,
        statePaths,
      });
      const plan = { ...defaultPlan(), tools: false };
      const other = new OperationLock(statePaths);
      await other.acquire("backup");
      try {
        const error = await service.run(plan, { apply: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OperationLockError);
        expect(existsSync(path.join(dir, "home"))).toBe(false); // rien d'écrit
        expect((await service.run(plan)).every((s) => s.ok)).toBe(true); // la simulation ne prend pas le verrou
      } finally {
        await other.release();
      }
      await service.run(plan, { apply: true });
      expect(await new OperationLock(statePaths).holderDescription()).toContain("restore");
    });
  });
});
