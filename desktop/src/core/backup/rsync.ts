// rsync de la sauvegarde (port de `BackupEngine.rsync`, `copyChunks`, `rsyncPath`, RsyncErrors).
// Arguments exacts de la 0.8.0 (parity/platform.md §2.1, behavior.md §3.4) :
//   rsync -a [-H] --out-format=%i|%n --partial-dir=.cairn-partial --delete [--delete-excluded] [-n]
//         [--exclude-from=F] [filtres] [arguments en plus] [-r --files-from=F] [--link-dest=BASE] SRC/ DEST/
// La sortie est lue ligne à ligne, rien n'est accumulé (593f593) ; seules les 20 dernières lignes de stderr sont
// gardées (process.ts). Les tailles des fichiers transférés sont relevées au fil de l'eau. Les lignes de stderr d'un
// élément dont macOS refuse la lecture sont toutes comptées au fil de l'eau (nombre et premiers chemins), sans être
// gardées dans les dernières lignes : elles ne masquent pas une autre erreur.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { constants } from "../fs.ts";
import { access, lstat, mkdir, readdir, rm, stat, writeFile } from "../fs-promises.ts";
import { DeniedCounter, type PermissionDenied, permissionDenied } from "../full-disk-access.ts";
import { type ProcessGroup, start } from "../process.ts";
import type { BackupPart } from "./types.ts";

export const GNU_RSYNC = "/opt/homebrew/bin/rsync";
export const SYSTEM_RSYNC = "/usr/bin/rsync";
export const PARTIAL_DIR = ".cairn-partial";

/** Binaire rsync : GNU (Homebrew, liens physiques gardés avec `-H`) sinon openrsync de macOS. */
export interface RsyncBinary {
  path: string;
  /** rsync GNU : `-H`, et une partie copiée en un seul rsync (sinon les liens entre dossiers seraient perdus). */
  gnu: boolean;
}

/** `/opt/homebrew/bin/rsync` s'il est exécutable, sinon `/usr/bin/rsync`. */
export async function detectRsync(): Promise<RsyncBinary> {
  try {
    await access(GNU_RSYNC, constants.X_OK);
    return { path: GNU_RSYNC, gnu: true };
  } catch {
    return { path: SYSTEM_RSYNC, gnu: false };
  }
}

/** Morceau de copie : un dossier du premier niveau (`label`), ou les fichiers du premier niveau (`label` nul). */
export interface CopyChunk {
  label: string | null;
  filters: string[];
}

/** Un seul morceau, sans filtre. */
export const WHOLE_PART: readonly CopyChunk[] = [{ label: null, filters: [] }];

function sortNames(names: string[]): string[] {
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Copie d'une partie en morceaux : un par dossier du premier niveau, puis un pour les fichiers du premier niveau.
 * Un seul morceau sans filtre pour une liste de fichiers, ≤ 1 entrée, un nom avec joker ou sans sous-dossier.
 */
export async function copyChunks(part: BackupPart): Promise<CopyChunk[]> {
  let names: string[];
  try {
    names = sortNames(await readdir(part.source));
  } catch {
    names = [];
  }
  if (part.filesFrom !== null || names.length <= 1 || names.some((n) => /[*?[\]\\]/.test(n))) return [...WHOLE_PART];
  const dirs: string[] = [];
  const files: string[] = [];
  for (const n of names) {
    // `fileExists(isDirectory:)` suit les liens : un lien vers un dossier compte comme un dossier.
    let isDir = false;
    try {
      isDir = (await stat(path.join(part.source, n))).isDirectory();
    } catch {
      isDir = false;
    }
    (isDir ? dirs : files).push(n);
  }
  if (dirs.length === 0) return [...WHOLE_PART];
  const chunks: CopyChunk[] = dirs.map((d) => ({
    label: d,
    filters: [`--include=/${d}`, `--include=/${d}/**`, "--exclude=*"],
  }));
  if (files.length > 0) chunks.push({ label: null, filters: [...files.map((f) => `--include=/${f}`), "--exclude=*"] });
  return chunks;
}

/** Options d'un rsync de partie. */
export interface RsyncRequest {
  part: BackupPart;
  dest: string;
  /** Base `--link-dest` (dossier de la partie dans la version précédente). */
  linkDest: string | null;
  dryRun: boolean;
  /** Fichiers abîmés dans la base : jamais liés, recopiés d'abord depuis la source. */
  forceRecopy?: readonly string[];
  /** Règles ajoutées après les exclusions de la partie (morceau). */
  filters?: readonly string[];
  deleteExcluded?: boolean;
  extraArgs?: readonly string[];
}

/** Fichiers écrits pour rsync (dans un dossier temporaire). */
export interface RsyncFiles {
  excludeFrom?: string;
  filesFrom?: string;
}

/** Arguments du rsync principal, dans l'ordre exact de la 0.8.0. */
export function rsyncArgs(
  binary: RsyncBinary,
  r: {
    source: string;
    dest: string;
    linkDest: string | null;
    dryRun: boolean;
    filters?: readonly string[];
    extraArgs?: readonly string[];
    deleteExcluded?: boolean;
  },
  files: RsyncFiles,
): string[] {
  const args = ["-a", "--out-format=%i|%n", `--partial-dir=${PARTIAL_DIR}`, "--delete"];
  if (r.deleteExcluded ?? true) args.push("--delete-excluded");
  if (binary.gnu) args.splice(1, 0, "-H");
  if (r.dryRun) args.push("-n");
  if (files.excludeFrom) args.push(`--exclude-from=${files.excludeFrom}`);
  args.push(...(r.filters ?? []), ...(r.extraArgs ?? []));
  if (files.filesFrom) args.push("-r", `--files-from=${files.filesFrom}`);
  if (r.linkDest) args.push(`--link-dest=${r.linkDest}`);
  args.push(withSlash(r.source), `${r.dest}/`);
  return args;
}

function withSlash(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

/** Ligne `%i|%n` : fichier (2e caractère `f`), transféré (`>f`, `<f`) ou lié à la base (`hf`). */
export interface OutLine {
  name: string;
  transferred: boolean;
}

export function parseOutLine(line: string): OutLine | null {
  const bar = line.indexOf("|");
  if (bar < 0) return null;
  const item = line.slice(0, bar);
  if (item[1] !== "f") return null;
  return { name: line.slice(bar + 1), transferred: item.startsWith(">f") || item.startsWith("<f") };
}

export interface RsyncResult {
  /** Fichiers transférés (`>f`, `<f`). */
  transferred: number;
  /** Fichiers examinés (transférés ou liés). */
  examined: number;
  /** Somme des tailles, à la source, des fichiers ordinaires transférés (si `measure`). */
  bytes: number;
  /** Code de sortie (`-1` si rsync a été tué par un signal). */
  status: number;
  /** 20 dernières lignes de stderr, hors éléments refusés. */
  errors: string;
  /** Éléments dont macOS a refusé la lecture (EPERM ou EACCES). */
  denied: PermissionDenied;
  cancelled: boolean;
}

export interface RsyncRun {
  binary: RsyncBinary;
  group?: ProcessGroup;
  /** Relever la taille à la source des fichiers transférés (`bytes`). */
  measure?: boolean;
  /**
   * `(copiés, examinés, fichier courant, octets relevés)`, au plus dix fois par seconde, puis une dernière fois à la
   * fin.
   */
  onProgress?: (transferred: number, examined: number, current: string, bytes: number) => void;
  /** Ligne brute (tests). */
  onArgs?: (args: string[]) => void;
}

/** Relevé des tailles à la source, sans garder les noms : au plus `limit` `lstat` en vol. */
class SizeMeter {
  private pending = 0;
  private queue: string[] = [];
  total = 0;
  private idle: Array<() => void> = [];

  constructor(
    private readonly source: string,
    private readonly limit = 32,
  ) {}

  add(name: string): void {
    this.queue.push(name);
    this.pump();
  }

  private pump(): void {
    while (this.pending < this.limit && this.queue.length > 0) {
      const name = this.queue.shift()!;
      this.pending += 1;
      lstat(path.join(this.source, name))
        .then((s) => {
          if (s.isFile()) this.total += s.size;
        })
        .catch(() => {})
        .finally(() => {
          this.pending -= 1;
          this.pump();
          if (this.pending === 0 && this.queue.length === 0) for (const done of this.idle.splice(0)) done();
        });
    }
  }

  drained(): Promise<void> {
    if (this.pending === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }
}

/**
 * Lance rsync pour une partie. Simulation : comparaison directe à la version de base (sans `--link-dest`), car
 * openrsync échoue avec `-n` et un `--link-dest` absent (e229e52) ; `-n` n'écrit rien.
 */
export async function runRsync(request: RsyncRequest, run: RsyncRun): Promise<RsyncResult> {
  const { part, dryRun } = request;
  let dest = request.dest;
  let linkDest = request.linkDest;
  if (dryRun && linkDest && (await exists(linkDest))) {
    dest = linkDest;
    linkDest = null;
  }
  const tmp = path.join(os.tmpdir(), `cairn-${randomUUID().toUpperCase()}`);
  await mkdir(tmp, { recursive: true });
  try {
    const files: RsyncFiles = {};
    if (part.excludes.length > 0) {
      files.excludeFrom = path.join(tmp, "exclude.txt");
      await writeFile(files.excludeFrom, `${part.excludes.join("\n")}\n`, "utf8");
    }
    if (part.filesFrom !== null) {
      files.filesFrom = path.join(tmp, "files.txt");
      await writeFile(files.filesFrom, `${part.filesFrom.join("\n")}\n`, "utf8");
    }
    const recopy = request.forceRecopy ?? [];
    const baseExists = linkDest !== null && (await exists(linkDest));
    if (baseExists && recopy.length > 0) {
      // Fichiers abîmés dans la version précédente : copie préalable sans lien, depuis la source.
      const list = path.join(tmp, "recopy.txt");
      await writeFile(list, `${recopy.map((p) => `/${p}`).join("\n")}\n`, "utf8");
      if (!dryRun) {
        await mkdir(dest, { recursive: true });
        await start(run.binary.path, ["-a", `--files-from=${list}`, `${part.source}/`, `${dest}/`], {
          group: run.group,
          stderr: "ignore",
          captureStdout: false,
          onData: () => {},
        }).result;
      }
    }
    if (!dryRun) await mkdir(dest, { recursive: true });
    const args = rsyncArgs(
      run.binary,
      {
        source: part.source,
        dest,
        linkDest: baseExists ? linkDest : null,
        dryRun,
        filters: request.filters,
        extraArgs: request.extraArgs,
        deleteExcluded: request.deleteExcluded,
      },
      files,
    );
    run.onArgs?.(args);

    const meter = run.measure ? new SizeMeter(part.source) : null;
    let transferred = 0;
    let examined = 0;
    let lastReport = 0;
    const denied = new DeniedCounter();
    const proc = start(run.binary.path, args, {
      group: run.group,
      onStderrLine: (line) => {
        const item = permissionDenied(line);
        if (item === null) return true;
        denied.add(item);
        return false;
      },
      onLine: (line) => {
        const out = parseOutLine(line);
        if (!out) return;
        examined += 1;
        if (out.transferred) {
          transferred += 1;
          meter?.add(out.name);
        }
        const now = Date.now();
        if (run.onProgress && now - lastReport >= 100) {
          lastReport = now;
          run.onProgress(transferred, examined, out.name, meter?.total ?? 0);
        }
      },
    });
    const result = await proc.result;
    await meter?.drained();
    run.onProgress?.(transferred, examined, "", meter?.total ?? 0);
    return {
      transferred,
      examined,
      bytes: meter?.total ?? 0,
      status: result.code ?? -1,
      errors: result.stderrTail.join("\n"),
      denied: denied.value(),
      cancelled: result.cancelled,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Code de sortie d'une partie : un échec (≠ 0, 23, 24) l'emporte sur un transfert partiel. */
export function worstStatus(current: number, next: number): number {
  if (next !== 0 && (current === 0 || current === 23 || current === 24)) return next;
  return current;
}

/** 23 et 24 : transfert partiel (fichier illisible ou disparu pendant la copie), un avertissement. */
export function isPartialTransfer(status: number): boolean {
  return status === 23 || status === 24;
}

/** Ligne de synthèse de rsync GNU pour le code 23 (`rsync error: some files/attrs were not transferred …`). */
export function isPartialSummary(line: string): boolean {
  return /^rsync error: some files(?:\/attrs)? were not transferred/.test(line);
}
