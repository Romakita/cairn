// OperationLock (port de SupportTests.swift) et compatibilité avec la 0.8.0 (même fichier, même flock).
import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLockHeld, OperationLock, OperationLockError, withOperationLock } from "../../src/core/lock.ts";
import { nativeAvailable, swiftTestHelper } from "../helpers/native.ts";

const available = nativeAvailable();
const swiftHelper = swiftTestHelper();
if (available && !swiftHelper) {
  console.warn(
    "CairnTestHelper (Swift 0.8.0) not built: the cross-version lock test is skipped " +
      "(swift build --package-path Cairn --product CairnTestHelper)",
  );
}

function tempState(): { stateDir: string } {
  return { stateDir: path.join(mkdtempSync(path.join(os.tmpdir(), "cairn-lock-")), "state") };
}

/** Lance un processus et attend sa première ligne (« held »). */
function launch(executable: string, args: string[]): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes("\n")) resolve({ child, line: out.trim() });
    });
    child.once("exit", (code) => resolve({ child, line: `exit ${code}` }));
    child.once("error", reject);
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function expectHeldError(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OperationLockError);
  expect((error as OperationLockError).reason).toBe("alreadyHeld");
}

describe.skipIf(!available)("lock", () => {
  test("second acquire fails while held, succeeds after release", async () => {
    const paths = tempState();
    const a = new OperationLock(paths);
    const b = new OperationLock(paths);
    await a.acquire("backup");
    await expectHeldError(b.acquire("restore"));
    expect(b.isHeld).toBe(false);
    await a.release();
    await b.acquire("restore");
    expect(b.isHeld).toBe(true);
    await b.release();
    expect(b.isHeld).toBe(false);
  });

  test("lock file: pid and operation, mode 600, under state/", async () => {
    const paths = tempState();
    const lock = new OperationLock(paths);
    await lock.acquire("git-clean");
    expect(lock.file).toBe(path.join(paths.stateDir, "operation.lock"));
    expect(readFileSync(lock.file, "utf8")).toBe(`${process.pid} git-clean\n`);
    expect(statSync(lock.file).mode & 0o777).toBe(0o600);
    expect(await lock.holderDescription()).toBe(`${process.pid} git-clean`);
    await lock.release();
    // Un nom plus court réécrit tout le contenu (ftruncate).
    await lock.acquire("verify");
    expect(readFileSync(lock.file, "utf8")).toBe(`${process.pid} verify\n`);
    await lock.release();
  });

  test("isHeld probes without taking the lock nor creating the file", async () => {
    const paths = tempState();
    expect(await OperationLock.isHeld(paths)).toBe(false);
    expect(existsSync(path.join(paths.stateDir, "operation.lock"))).toBe(false);
    const lock = new OperationLock(paths);
    await lock.acquire("backup-dry-run");
    expect(await OperationLock.isHeld(paths)).toBe(true);
    await lock.release();
    expect(await OperationLock.isHeld(paths)).toBe(false);
    // La sonde ne garde pas le verrou.
    await lock.acquire("backup");
    await lock.release();
  });

  test("withOperationLock releases after an error", async () => {
    const paths = tempState();
    await expect(
      withOperationLock(paths, "remove-destination", async () => {
        expect(await OperationLock.isHeld(paths)).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await OperationLock.isHeld(paths)).toBe(false);
  });

  test("lock held by another process, freed when it is killed", async () => {
    const paths = tempState();
    const script = path.resolve(import.meta.dir, "../helpers/hold-lock.ts");
    const { child, line } = await launch(process.execPath, [script, paths.stateDir, "1.5"]);
    expect(line).toBe("held");
    expect(await OperationLock.isHeld(paths)).toBe(true);
    const mine = new OperationLock(paths);
    await expectHeldError(mine.acquire("backup"));
    await exited(child);
    // Fin brutale (SIGKILL) : le système a libéré le verrou.
    await mine.acquire("backup");
    expect(mine.isHeld).toBe(true);
    // Et dans l'autre sens : l'autre processus ne peut pas le prendre (code 3).
    const other = await launch(process.execPath, [script, paths.stateDir, "0"]);
    expect(other.line).toBe("exit 3");
    await mine.release();
  }, 20_000);

  test.skipIf(!swiftHelper)(
    "compatible with the Swift 0.8.0 OperationLock, both ways",
    async () => {
      const paths = tempState();
      const file = path.join(paths.stateDir, "operation.lock");
      // Swift tient le verrou → vu tenu par TypeScript.
      const swift = await launch(swiftHelper!, ["--hold-lock", file, "1.5"]);
      expect(swift.line).toBe("held");
      expect(await isLockHeld(file)).toBe(true);
      const mine = new OperationLock(paths);
      await expectHeldError(mine.acquire("backup"));
      expect(readFileSync(file, "utf8")).toMatch(/^\d+ test\n$/);
      await exited(swift.child);
      // TypeScript tient le verrou → Swift ne peut pas le prendre (code 3 = alreadyHeld).
      await mine.acquire("backup");
      const refused = await launch(swiftHelper!, ["--hold-lock", file, "0"]);
      expect(refused.line).toBe("exit 3");
      await mine.release();
      // Libéré → Swift le prend.
      const again = await launch(swiftHelper!, ["--hold-lock", file, "0"]);
      expect(again.line).toBe("held");
      await exited(again.child);
    },
    20_000,
  );
});
