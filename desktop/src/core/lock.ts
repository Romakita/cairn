// Verrou d'opération partagé entre l'app et la commande `cairn` (port de `OperationLock`, Support.swift).
// `state/operation.lock`, `flock` exclusif non bloquant, contenu `"<pid> <operation>\n"`, droits 600. Le système
// le libère si le processus se termine, même brutalement. Même fichier et même `flock` que la 0.8.0 : l'app Swift
// et la version TypeScript se voient mutuellement.
import path from "node:path";
import { promisify } from "node:util";
import { close, constants, ftruncate, open, write } from "./fs.ts";
import { mkdir, readFile } from "./fs-promises.ts";
import { native } from "./native.ts";

// Descripteurs numériques (pas de `FileHandle`) : un `FileHandle` perdu est fermé par le ramasse-miettes, ce qui
// libérerait le verrou en silence. Un descripteur reste ouvert jusqu'à `release()` ou la fin du processus.
const openFd = promisify(open);
const closeFd = promisify(close);
const truncateFd = promisify(ftruncate);
const writeFd = promisify(write);

/** Emplacement de `state/` (voir `CairnPaths`). */
export interface StatePaths {
  stateDir: string;
}

export type LockedOperation = "backup" | "backup-dry-run" | "verify" | "restore" | "git-clean" | "remove-destination";

export const OPERATION_LOCK_FILE = "operation.lock";

export function operationLockFile(paths: StatePaths): string {
  return path.join(paths.stateDir, OPERATION_LOCK_FILE);
}

/** `alreadyHeld` : une autre opération tient le verrou ; `cannotOpen` : fichier inaccessible (`errno`). */
export class OperationLockError extends Error {
  constructor(
    readonly reason: "alreadyHeld" | "cannotOpen",
    readonly errno?: string,
  ) {
    super(reason === "alreadyHeld" ? "another operation is already running" : `cannot open lock (${errno})`);
    this.name = "OperationLockError";
  }
}

export class OperationLock {
  readonly file: string;
  private fd: number | null = null;

  constructor(paths: StatePaths) {
    this.file = operationLockFile(paths);
  }

  /** Tente de prendre le verrou sans attendre ; lève `OperationLockError("alreadyHeld")` s'il est tenu ailleurs. */
  async acquire(operation: LockedOperation | string): Promise<void> {
    if (this.fd !== null) throw new OperationLockError("alreadyHeld");
    await mkdir(path.dirname(this.file), { recursive: true });
    let fd: number;
    try {
      fd = await openFd(this.file, constants.O_RDWR | constants.O_CREAT, 0o600);
    } catch (error) {
      throw new OperationLockError("cannotOpen", (error as NodeJS.ErrnoException).code);
    }
    let locked = false;
    try {
      locked = native().flockTryExclusive(fd);
    } finally {
      if (!locked) await closeFd(fd);
    }
    if (!locked) throw new OperationLockError("alreadyHeld");
    this.fd = fd;
    // Information seulement : qui tient le verrou.
    await truncateFd(fd, 0);
    await writeFd(fd, `${process.pid} ${operation}\n`, 0, "utf8");
  }

  /** Ce verrou est tenu par cet objet. */
  get isHeld(): boolean {
    return this.fd !== null;
  }

  /** Libère le verrou (sans effet s'il n'est pas tenu). */
  async release(): Promise<void> {
    const fd = this.fd;
    if (fd === null) return;
    this.fd = null;
    try {
      native().flockUnlock(fd);
    } finally {
      await closeFd(fd);
    }
  }

  /** Contenu du fichier (`"<pid> <operation>"`), à titre d'information. */
  async holderDescription(): Promise<string | null> {
    try {
      return (await readFile(this.file, "utf8")).trim();
    } catch {
      return null;
    }
  }

  /** Verrou tenu par une opération en cours (cette app ou la commande `cairn`), sans le garder. */
  static async isHeld(paths: StatePaths): Promise<boolean> {
    return isLockHeld(operationLockFile(paths));
  }
}

/** Sonde un fichier de verrou : `true` s'il est tenu (par ce processus ou un autre). */
export async function isLockHeld(file: string): Promise<boolean> {
  let fd: number;
  try {
    fd = await openFd(file, constants.O_RDONLY);
  } catch {
    return false;
  }
  try {
    if (!native().flockTryExclusive(fd)) return true;
    native().flockUnlock(fd);
    return false;
  } finally {
    await closeFd(fd);
  }
}

/** Exécute `work` sous le verrou, libéré à la fin (même en cas d'erreur). */
export async function withOperationLock<T>(
  paths: StatePaths,
  operation: LockedOperation,
  work: () => Promise<T>,
): Promise<T> {
  const lock = new OperationLock(paths);
  await lock.acquire(operation);
  try {
    return await work();
  } finally {
    await lock.release();
  }
}
