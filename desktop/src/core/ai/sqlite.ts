// Copie cohérente des bases SQLite des outils IA (port d'`AIBackup.snapshot`, parity/behavior.md §3.5).
// design.md, décision 9 : `/usr/bin/sqlite3 .backup` et `PRAGMA quick_check`, identiques sous Bun (tests) et sous
// le Node d'Electron (app), sans module natif. Rien n'est jamais créé ni modifié à côté de la base de l'outil :
// la source est ouverte en lecture seule (`-readonly`), et en mode `immutable` seulement pour une base WAL fermée
// proprement (`isCleanWAL`).
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { t } from "../l10n.ts";
import { run } from "../process.ts";

export const SQLITE3 = "/usr/bin/sqlite3";
/** Délai d'attente d'un verrou de l'outil (`sqlite3_busy_timeout`), en millisecondes. */
export const BUSY_TIMEOUT_MS = 2000;
export const SNAPSHOT_ATTEMPTS = 5;
/** Délai maximal d'une commande sqlite3 (une base de plusieurs Go se copie en quelques secondes). */
const SQLITE_TIMEOUT_MS = 10 * 60 * 1000;

/** Échec d'une copie : le message nomme la base (`ai.error.sqlite`). */
export class SQLiteSnapshotError extends Error {
  constructor(
    readonly file: string,
    readonly detail?: string,
  ) {
    super(t("ai.error.sqlite", path.basename(file)));
    this.name = "SQLiteSnapshotError";
  }

  override toString(): string {
    return this.message;
  }
}

/** Argument d'une commande point du shell sqlite3 (`.backup "…"`) : guillemets doubles, `\` et `"` échappés. */
function dotArgument(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Base en WAL fermée proprement : en-tête WAL (octets 18-19 = 2) et aucun fichier annexe (-wal, -shm, -journal).
 * Tout est alors dans le fichier principal. Une base en journal classique avec un -journal « chaud » (outil planté)
 * demande une récupération : elle n'est jamais lue en mode immutable.
 */
export async function isCleanWAL(file: string): Promise<boolean> {
  for (const suffix of ["-wal", "-shm", "-journal"]) if (await exists(file + suffix)) return false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    if (bytesRead !== 20) return false;
    return header.subarray(0, 16).toString("latin1") === "SQLite format 3\0" && header[18] === 2 && header[19] === 2;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Taille et date de modification en nanosecondes (détecte une réécriture pendant la copie). */
async function fileStamp(file: string): Promise<string | null> {
  try {
    const s = await stat(file, { bigint: true });
    return `${s.size}:${s.mtimeNs}`;
  } catch {
    return null;
  }
}

/** `PRAGMA quick_check` = `ok` sur la copie (ouverte en lecture seule). */
export async function quickCheck(file: string): Promise<boolean> {
  try {
    const r = await run(SQLITE3, ["-readonly", "-bail", file, "PRAGMA quick_check;"], {
      stderr: "ignore",
      timeoutMs: SQLITE_TIMEOUT_MS,
    });
    return r.code === 0 && r.stdout.trim() === "ok";
  } catch {
    return false;
  }
}

async function removeCopy(dest: string): Promise<void> {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(dest + suffix, { force: true });
}

/**
 * Copie par l'API de sauvegarde en ligne (`.backup`) ; `immutable` : lecture sans verrou ni fichier annexe
 * (`file:…?mode=ro&immutable=1`). La copie passe ensuite en `journal_mode=DELETE` : base autonome, sans -wal.
 */
export async function sqliteBackup(source: string, dest: string, immutable: boolean): Promise<void> {
  const name = immutable ? `${pathToFileURL(source).href}?mode=ro&immutable=1` : source;
  let r = await run(
    SQLITE3,
    ["-readonly", "-bail", name, `.timeout ${BUSY_TIMEOUT_MS}`, `.backup ${dotArgument(dest)}`],
    { timeoutMs: SQLITE_TIMEOUT_MS },
  );
  if (r.code !== 0) throw new SQLiteSnapshotError(source, r.stderrTail.join("\n"));
  r = await run(SQLITE3, ["-bail", dest, "PRAGMA journal_mode=DELETE;"], {
    stderr: "ignore",
    timeoutMs: SQLITE_TIMEOUT_MS,
  });
  // L'ouverture en WAL de la copie peut laisser un -shm (WAL persistant de macOS) : la copie est en DELETE.
  for (const suffix of ["-wal", "-shm"]) await rm(dest + suffix, { force: true });
  if (r.code !== 0) throw new SQLiteSnapshotError(dest);
}

export interface SnapshotDeps {
  backup?: (source: string, dest: string, immutable: boolean) => Promise<void>;
  quickCheck?: (file: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Un essai : copie normale, sinon repli immutable pour une base WAL fermée proprement. */
export async function snapshotOnce(source: string, dest: string, deps: SnapshotDeps = {}): Promise<void> {
  const backup = deps.backup ?? sqliteBackup;
  const check = deps.quickCheck ?? quickCheck;
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { force: true });
  try {
    await backup(source, dest, false);
  } catch (error) {
    // Base en WAL fermée proprement (SQLite embarqué de Codex) : une connexion en lecture seule ne peut pas créer
    // le -shm (SQLITE_CANTOPEN). Tout est dans le fichier principal : lecture « immutable » (aucun fichier créé,
    // aucun verrou), puis contrôle que la base n'a pas bougé pendant la copie (un checkpoint la réécrirait).
    if (!(await isCleanWAL(source))) throw error;
    const before = await fileStamp(source);
    await rm(dest, { force: true });
    await backup(source, dest, true);
    if (before === null || (await fileStamp(source)) !== before || !(await check(dest))) {
      await rm(dest, { force: true });
      throw new SQLiteSnapshotError(source);
    }
  }
}

/**
 * Copie cohérente d'une base, même si l'outil est en train d'écrire. L'outil peut fermer sa base ou faire un
 * checkpoint pendant la copie : 5 essais, pause de 100 ms × numéro d'essai. En cas d'échec, aucun fichier ne reste à
 * `dest` (la restauration installerait une copie vide ou partielle) : `dest`, `-journal`, `-wal` et `-shm` supprimés.
 */
export async function snapshot(source: string, dest: string, deps: SnapshotDeps = {}): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    try {
      await snapshotOnce(source, dest, deps);
      return;
    } catch (error) {
      lastError = error;
      await sleep(100 * (attempt + 1));
    }
  }
  await removeCopy(dest);
  throw lastError instanceof SQLiteSnapshotError ? lastError : new SQLiteSnapshotError(source, String(lastError));
}
