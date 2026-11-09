// Modification et suppression d'une destination, actions de sa page (port de DestinationEditTests.swift).
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyDestinationState, loadRunState, saveRunState } from "../../src/core/backup/run-state.ts";
import { destination } from "../../src/core/config.ts";
import { BACKUP_ACTIONS, unavailableReason } from "../../src/core/destinations/actions.ts";
import { updatingConnection } from "../../src/core/destinations/edit.ts";
import {
  canExecuteRemoval,
  executeRemoval,
  planRemoval,
  RemovalError,
  removalBackupBytes,
} from "../../src/core/destinations/removal.ts";
import { OperationLock, OperationLockError } from "../../src/core/lock.ts";
import { fileRunStatePort } from "../../src/core/schedule/tick.ts";
import { nativeAvailable } from "../helpers/native.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  await body(await realpath(await mkdtemp(path.join(os.tmpdir(), "cairn-dest-"))));
}

async function writeSized(file: string, size: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, 1));
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** `state/` de test avec une erreur posée sur chaque destination. */
async function stateWith(ids: string[], root: string) {
  const paths = { state: path.join(root, "state"), stateDir: path.join(root, "state") };
  const destinations: Record<string, ReturnType<typeof emptyDestinationState>> = {};
  for (const id of ids) destinations[id] = { ...emptyDestinationState(), lastError: "x" };
  await saveRunState(paths, { destinations });
  return { paths, runState: fileRunStatePort(paths) };
}

const absent = () => `/Volumes/cairn-absent-${crypto.randomUUID().toUpperCase()}/Backups`;

describe("destination-edit", () => {
  // MARK: Modification

  test("edit_keeps_identity", () => {
    const original = destination("main", "smb", {
      url: "smb://syno/backups",
      username: "romain",
      keychain: "ancien",
      encrypted: true,
      retention: { mode: "count", count: 7 },
    });
    const edited = destination("smb-2", "smb", { url: "smb://syno/backups/mac", username: "admin", encrypted: false });
    const d = updatingConnection(original, edited);
    expect(d.id).toBe("main");
    expect(d.url).toBe("smb://syno/backups/mac");
    expect(d.username).toBe("admin");
    expect(d.encrypted).toBe(true); // le chiffrement ne change pas à la modification
    expect(d.retention).toEqual({ mode: "count", count: 7 });
    expect(d.keychain).toBe("ancien");
    expect(d.provider).toBe("smb");
  });

  // MARK: Simulation de la suppression

  test("plan_keeping_backups_touches_nothing_on_destination", async () => {
    await withTempDir(async (dir) => {
      await writeSized(path.join(dir, "cairn/Ce-Mac/versions/2026-01-01T120000/f"), 10);
      const d = destination("usb", "local", { path: dir, encrypted: false });
      const plan = await planRemoval(d, false, { machine: "Ce-Mac" });
      expect(plan.items).toEqual([
        { kind: "configuration", id: "usb" },
        { kind: "state", id: "usb" },
      ]);
      expect(canExecuteRemoval(plan)).toBe(true);
    });
  });

  test("plan_lists_only_this_mac_backups", async () => {
    await withTempDir(async (dir) => {
      await writeSized(path.join(dir, "cairn/Ce-Mac/versions/2026-01-01T120000/f"), 8192);
      await writeSized(path.join(dir, "cairn/Autre-Mac/versions/2026-01-01T120000/f"), 8192);
      const d = destination("usb", "local", { path: dir, encrypted: false });
      const plan = await planRemoval(d, true, { machine: "Ce-Mac" });
      const mine = path.join(dir, "cairn/Ce-Mac");
      expect(plan.items).toEqual([
        { kind: "configuration", id: "usb" },
        { kind: "state", id: "usb" },
        { kind: "backups", path: mine, bytes: removalBackupBytes(plan) },
      ]);
      expect(removalBackupBytes(plan)).toBeGreaterThanOrEqual(8192);
    });
  });

  test("plan_encrypted_lists_image_but_never_its_password", async () => {
    await withTempDir(async (dir) => {
      const image = path.join(dir, "cairn-Ce-Mac.sparsebundle");
      await writeSized(path.join(image, "bands/0"), 4096);
      await mkdir(path.join(dir, "cairn-Autre-Mac.sparsebundle"));
      const d = destination("usb", "local", { path: dir, encrypted: true });
      const plan = await planRemoval(d, true, { machine: "Ce-Mac" });
      expect(plan.items).toContainEqual({ kind: "backups", path: image, bytes: removalBackupBytes(plan) });
      // config, état, image : le mot de passe de l'image reste au Trousseau
      expect(plan.items.length).toBe(3);
      // l'image d'un autre Mac ne doit jamais être listée
      expect(plan.items.some((i) => i.kind === "backups" && i.path.includes("Autre-Mac"))).toBe(false);
    });
  });

  test("plan_unreachable_destination_blocks_backup_removal", async () => {
    const d = destination("usb", "local", { path: absent(), encrypted: false });
    const keep = await planRemoval(d, false, { machine: "Ce-Mac" });
    expect(canExecuteRemoval(keep)).toBe(true); // garder les sauvegardes reste possible sans la destination
    const remove = await planRemoval(d, true, { machine: "Ce-Mac" });
    expect(remove.backupsUnavailable).not.toBeNull();
    expect(canExecuteRemoval(remove)).toBe(false);
  });

  test("plan on a destination where nothing was created yet: nothing to remove, still possible", async () => {
    await withTempDir(async (dir) => {
      const d = destination("usb", "local", { path: path.join(dir, "pas-encore"), encrypted: false });
      const plan = await planRemoval(d, true, { machine: "Ce-Mac" });
      expect(plan.backupsUnavailable).toBeNull();
      expect(plan.items.length).toBe(2);
      expect(await exists(path.join(dir, "pas-encore"))).toBe(false);
    });
  });

  // MARK: Actions de la page

  test("actions_nothing_to_verify", () => {
    const c = { reachable: true, backingUp: false, verifying: false, hasBackups: false };
    expect(unavailableReason("verify", c)).toBe("backup.unavailable.nothing_to_verify");
    expect(unavailableReason("verifyFull", c)).toBe("backup.unavailable.nothing_to_verify");
    expect(unavailableReason("backup", c)).toBeNull();
    expect(unavailableReason("simulate", c)).toBeNull();
  });

  test("actions_unreachable", () => {
    const c = { reachable: false, backingUp: false, verifying: false, hasBackups: true };
    for (const a of BACKUP_ACTIONS) expect(unavailableReason(a, c)).toBe("backup.unavailable.unreachable");
    const unknown = { ...c, reachable: null };
    for (const a of BACKUP_ACTIONS) expect(unavailableReason(a, unknown)).toBeNull(); // pas encore sondée
  });

  test("actions_running", () => {
    // « Sauvegarder maintenant » aussi : la destination en cours affiche « Arrêter », les autres attendent.
    const c = { reachable: true, backingUp: true, verifying: false, hasBackups: true };
    for (const a of BACKUP_ACTIONS) expect(unavailableReason(a, c)).toBe("backup.unavailable.running");
    const v = { reachable: true, backingUp: false, verifying: true, hasBackups: true };
    for (const a of BACKUP_ACTIONS) expect(unavailableReason(a, v)).toBe("backup.unavailable.verifying");
  });
});

describe.skipIf(!nativeAvailable())("destination-edit: execution", () => {
  test("execute_removes_backups_and_state", async () => {
    await withTempDir(async (dir) => {
      const { paths, runState } = await stateWith(["usb", "nas"], path.join(dir, "home"));
      const dest = path.join(dir, "dest");
      await writeSized(path.join(dest, "cairn-Ce-Mac.sparsebundle/bands/0"), 10);
      await writeSized(path.join(dest, "cairn-Autre-Mac.sparsebundle/bands/0"), 10);
      const d = destination("usb", "local", { path: dest, encrypted: true });
      const plan = await planRemoval(d, true, { machine: "Ce-Mac" });
      await executeRemoval(plan, { paths, runState });
      expect(await exists(path.join(dest, "cairn-Ce-Mac.sparsebundle"))).toBe(false);
      // l'image d'un autre Mac doit rester
      expect(await exists(path.join(dest, "cairn-Autre-Mac.sparsebundle"))).toBe(true);
      expect(Object.keys((await loadRunState(paths)).destinations)).toEqual(["nas"]);
    });
  });

  test("execute_keeping_backups_leaves_destination", async () => {
    await withTempDir(async (dir) => {
      const { paths, runState } = await stateWith(["usb"], path.join(dir, "home"));
      const dest = path.join(dir, "dest");
      await writeSized(path.join(dest, "cairn-Ce-Mac.sparsebundle/bands/0"), 10);
      const d = destination("usb", "local", { path: dest, encrypted: true });
      await executeRemoval(await planRemoval(d, false, { machine: "Ce-Mac" }), { paths, runState });
      expect(await exists(path.join(dest, "cairn-Ce-Mac.sparsebundle"))).toBe(true);
      expect((await loadRunState(paths)).destinations).toEqual({});
    });
  });

  test("execute_refused_while_operation_running", async () => {
    await withTempDir(async (dir) => {
      const { paths, runState } = await stateWith(["usb"], path.join(dir, "home"));
      const lock = new OperationLock(paths);
      await lock.acquire("backup");
      try {
        const d = destination("usb", "local", { path: dir, encrypted: false });
        const plan = await planRemoval(d, false, { machine: "Ce-Mac" });
        const error = await executeRemoval(plan, { paths, runState }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OperationLockError);
        expect((error as OperationLockError).reason).toBe("alreadyHeld");
      } finally {
        await lock.release();
      }
      expect(Object.keys((await loadRunState(paths)).destinations)).toEqual(["usb"]); // rien n'est retiré
    });
  });

  test("execute_unavailable_plan_changes_nothing", async () => {
    await withTempDir(async (dir) => {
      const { paths, runState } = await stateWith(["usb"], path.join(dir, "home"));
      const d = destination("usb", "local", { path: absent(), encrypted: false });
      const plan = await planRemoval(d, true, { machine: "Ce-Mac" });
      const error = await executeRemoval(plan, { paths, runState }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemovalError);
      expect(Object.keys((await loadRunState(paths)).destinations)).toEqual(["usb"]);
    });
  });
});
