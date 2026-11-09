// Moteur de sauvegarde (port de `BackupEngine.copy`, `finish`, `cancel`, `suspend`/`resume`) : rsync en
// sous-processus, versions par `--link-dest`, reprise des versions interrompues, comptage en parallèle de la copie.
// Une copie se finalise à part (`finish`) : le service lance la copie vers la destination suivante pendant ce temps.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import type { Retention } from "../config.ts";
import { DeniedCounter, type PermissionDenied } from "../full-disk-access.ts";
import { t } from "../l10n.ts";
import { ProcessGroup } from "../process.ts";
import { countFiles } from "./count.ts";
import { writeChecksums } from "./integrity.ts";
import { type ManifestExtra, macOSVersionString, writeManifest } from "./manifest.ts";
import { DestinationTracker } from "./progress.ts";
import {
  copyChunks,
  detectRsync,
  isPartialSummary,
  isPartialTransfer,
  type RsyncBinary,
  runRsync,
  WHOLE_PART,
  worstStatus,
} from "./rsync.ts";
import { BackupError, type BackupPart } from "./types.ts";
import {
  dateOfVersion,
  INCOMPLETE_PREFIX,
  isPartial,
  LATEST_LINK,
  linkSources,
  listIncomplete,
  listVersions,
  MAX_RESUME_AGE_MS,
  versionName,
  versionsDir,
} from "./versions.ts";

/**
 * Politique de rétention (`RetentionPolicy.keep`, fournie par le domaine des destinations) : dates des versions
 * complètes à garder.
 */
export type RetentionKeep = (versions: readonly Date[], retention: Retention, now: Date) => ReadonlySet<number>;

/**
 * Versions qui seraient supprimées avec cette rétention (`BackupEngine.excessVersions`). La politique porte sur les
 * versions complètes ; une version partielle est gardée tant qu'aucune version complète plus récente n'existe.
 */
export async function excessVersions(
  dir: string,
  retention: Retention,
  now: Date,
  keep: RetentionKeep,
): Promise<string[]> {
  const dated: Array<{ name: string; date: Date; partial: boolean }> = [];
  for (const name of await listVersions(dir)) {
    const date = dateOfVersion(name);
    if (date) dated.push({ name, date, partial: await isPartial(path.join(dir, name)) });
  }
  const complete = dated.filter((v) => !v.partial);
  const kept = keep(
    complete.map((v) => v.date),
    retention,
    now,
  );
  const newestComplete = complete.reduce<number | null>((m, v) => Math.max(m ?? -Infinity, v.date.getTime()), null);
  return dated
    .filter((v) =>
      v.partial ? newestComplete !== null && v.date.getTime() < newestComplete : !kept.has(v.date.getTime()),
    )
    .map((v) => v.name);
}

export interface CopyParams {
  parts: readonly BackupPart[];
  /** Racine de la destination montée (dossier local, partage ou image). */
  root: string;
  retention: Retention;
  dryRun: boolean;
  machine: string;
  now?: Date;
  manifestExtra?: ManifestExtra;
  /** Fichiers abîmés de la base, à recopier depuis la source (partie → chemins relatifs). */
  forceRecopy?: Readonly<Record<string, readonly string[]>>;
  /** Version partielle (`--only`, `--tool`). */
  partial?: boolean;
  warnings?: readonly string[];
  /** Fichiers par partie de la sauvegarde précédente (`fileCounts`) : total affiché avant la fin du comptage. */
  expectedFiles?: Readonly<Record<string, number>>;
}

/** Résultat d'une copie, en attente de finalisation (`finish`). */
export interface CopyResult {
  work: string;
  versionsDir: string;
  sources: Record<string, string>;
  parts: readonly BackupPart[];
  manifestExtra: ManifestExtra;
  now: Date;
  machine: string;
  partial: boolean;
  retention: Retention;
  dryRun: boolean;
  start: number;
  resumed: boolean;
  bytesByPart: Record<string, number>;
  filesByPart: Record<string, number>;
  files: number;
  bytes: number;
  warnings: string[];
  /** Éléments que macOS n'a pas laissé lire (toutes les parties). */
  permissionDenied: PermissionDenied;
}

export interface BackupOutcome {
  /** `null` en simulation. */
  version: string | null;
  dryRun: boolean;
  bytesByPart: Record<string, number>;
  /** Fichiers examinés par partie : estimation de la prochaine sauvegarde. */
  filesByPart: Record<string, number>;
  filesTransferred: number;
  bytesTransferred: number;
  warnings: string[];
  /** Éléments que macOS n'a pas laissé lire : sautés, la sauvegarde réussit avec un avertissement. */
  permissionDenied: PermissionDenied;
  deletedVersions: string[];
  /** Durée en secondes. */
  duration: number;
}

export function totalBytes(o: Pick<BackupOutcome, "bytesByPart">): number {
  return Object.values(o.bytesByPart).reduce((a, b) => a + b, 0);
}

export interface EngineOptions {
  /** rsync à utiliser (détecté sinon : GNU de Homebrew, sinon openrsync). */
  rsync?: RsyncBinary;
  /** Politique de rétention ; sans elle, aucune version n'est supprimée. */
  retentionKeep?: RetentionKeep;
  /** `operatingSystemVersionString` (manifest). */
  macos?: () => Promise<string>;
}

async function readable(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

export class BackupEngine {
  private cancelled = false;
  /** rsync de la copie (un à la fois) et des compteurs. */
  private readonly copyGroup = new ProcessGroup();
  private readonly countGroups = new Set<ProcessGroup>();
  private binary: RsyncBinary | null;

  constructor(private readonly options: EngineOptions = {}) {
    this.binary = options.rsync ?? null;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Arrête la copie et le comptage (SIGTERM puis SIGKILL après 5 s) ; aucun rsync ne démarre ensuite. */
  cancel(): void {
    this.cancelled = true;
    this.copyGroup.abort();
    for (const g of this.countGroups) g.abort();
  }

  /** Veille : rsync est suspendu (SIGSTOP), puis repris au réveil (SIGCONT). */
  suspend(): void {
    this.copyGroup.signalAll("SIGSTOP");
    for (const g of this.countGroups) g.signalAll("SIGSTOP");
  }

  resume(): void {
    this.copyGroup.signalAll("SIGCONT");
    for (const g of this.countGroups) g.signalAll("SIGCONT");
  }

  async rsync(): Promise<RsyncBinary> {
    this.binary ??= await detectRsync();
    return this.binary;
  }

  /** Sauvegarde les parties dans une nouvelle version (ou simule) : copie puis finalisation. */
  async run(
    params: CopyParams,
    tracker: DestinationTracker = new DestinationTracker("", params.dryRun),
  ): Promise<BackupOutcome> {
    const copied = await this.copy(params, tracker);
    if (!params.dryRun) tracker.beginFinishing(["listing", "checksums", "version"]);
    return this.finish(copied, tracker);
  }

  /** Copie des parties dans la version de travail (rsync). La version n'existe qu'après `finish`. */
  async copy(
    params: CopyParams,
    tracker: DestinationTracker = new DestinationTracker("", params.dryRun),
  ): Promise<CopyResult> {
    const start = Date.now();
    const now = params.now ?? new Date();
    const { parts, dryRun } = params;
    const binary = await this.rsync();
    const dir = versionsDir(params.root, params.machine);
    // Une simulation n'écrit rien sur la destination, pas même le dossier des versions.
    if (!dryRun) await mkdir(dir, { recursive: true });
    const sources = await linkSources(parts, dir);

    // Version de travail : reprise d'une version incomplète récente (< 7 jours), sinon nouvelle.
    let work: string;
    let resumed = false;
    const incompletes = await listIncomplete(dir);
    const last = incompletes.at(-1);
    const lastDate = last ? dateOfVersion(last.slice(INCOMPLETE_PREFIX.length)) : null;
    if (dryRun) {
      work = path.join(dir, `.dryrun-${randomUUID().toUpperCase()}`);
    } else if (last && lastDate && now.getTime() - lastDate.getTime() < MAX_RESUME_AGE_MS) {
      work = path.join(dir, last);
      resumed = true;
      for (const old of incompletes.slice(0, -1)) await rm(path.join(dir, old), { recursive: true, force: true });
    } else {
      for (const old of incompletes) await rm(path.join(dir, old), { recursive: true, force: true });
      work = path.join(dir, INCOMPLETE_PREFIX + versionName(now));
    }
    if (!dryRun) await mkdir(work, { recursive: true });

    // Comptage pendant la copie (4 rsync -n par partie). Le total connu d'une sauvegarde précédente sert jusqu'à la
    // fin du nouveau comptage ; les compteurs restent visibles pendant tout le comptage.
    const expected = params.expectedFiles ?? {};
    const known =
      parts.length > 0 && parts.every((p) => expected[p.target] !== undefined)
        ? parts.reduce((n, p) => n + (expected[p.target] ?? 0), 0)
        : null;
    const countGroup = new ProcessGroup();
    this.countGroups.add(countGroup);
    if (this.cancelled) countGroup.abort();
    const counted = new Map<string, number>();
    tracker.startCounting(known);
    const counting = (async () => {
      for (const part of parts) {
        if (countGroup.isAborted) return;
        const n = await countFiles(part, {
          binary,
          group: countGroup,
          onWorker: (i, w) => tracker.counter(i, w),
          onFound: (d) => tracker.found(d),
        });
        if (countGroup.isAborted) return;
        counted.set(part.target, n);
      }
      tracker.countingDone([...counted.values()].reduce((a, b) => a + b, 0));
    })().catch(() => {});

    const bytesByPart: Record<string, number> = {};
    const filesByPart: Record<string, number> = {};
    let files = 0;
    let processed = 0;
    let bytes = 0;
    const warnings = [...(params.warnings ?? [])];
    const denied = new DeniedCounter();
    try {
      for (const [index, part] of parts.entries()) {
        if (this.cancelled) throw BackupError.cancelled();
        const dest = path.join(work, part.target);
        const done = processed;
        const base = sources[part.target];
        const linkDest = base ? path.join(base, part.target) : null;
        // Un rsync par dossier du premier niveau : la liste de chacun est vite dressée, la progression avance dès le
        // début. rsync GNU (-H) : un seul rsync, sinon les liens physiques entre deux dossiers seraient copiés deux fois.
        const chunks = binary.gnu ? [...WHOLE_PART] : await copyChunks(part);
        let seen = 0;
        let partFiles = 0;
        let partBytes = 0;
        let status = 0;
        let allSucceeded = true;
        const errorLines: string[] = [];
        const partDenied = denied.count;
        for (const [i, chunk] of chunks.entries()) {
          if (this.cancelled) throw BackupError.cancelled();
          const baseSeen = seen;
          const baseFiles = partFiles;
          const baseBytes = partBytes;
          const position = {
            part: part.target,
            partIndex: index + 1,
            partCount: parts.length,
            folderIndex: i + 1,
            folderCount: chunks.length,
            folderName: chunk.label,
          };
          tracker.copy({
            ...position,
            listing: true,
            files: files + baseFiles,
            bytes: bytes + baseBytes,
            processed: done + baseSeen,
            current: "",
          });
          const r = await runRsync(
            {
              part,
              dest,
              linkDest,
              dryRun,
              forceRecopy: i === 0 ? (params.forceRecopy?.[part.target] ?? []) : [],
              filters: chunk.filters,
              deleteExcluded: chunk.filters.length === 0,
            },
            {
              binary,
              group: this.copyGroup,
              measure: true,
              onProgress: (n, m, current, b) => {
                seen = baseSeen + m;
                tracker.copy({
                  ...position,
                  listing: m === 0,
                  files: files + baseFiles + n,
                  bytes: bytes + baseBytes + b,
                  processed: done + baseSeen + m,
                  current,
                });
              },
            },
          );
          seen = baseSeen + r.examined;
          partFiles += r.transferred;
          partBytes += r.bytes;
          status = worstStatus(status, r.status);
          if (r.status !== 0) allSucceeded = false;
          if (r.errors) errorLines.push(r.errors);
          denied.merge(r.denied);
        }
        const errors = errorLines.join("\n");
        // Reprise copiée par morceaux (sans --delete-excluded) : une passe qui ne copie rien retire ce qui a disparu de
        // la source et ce qui est désormais exclu. Seulement si toutes les copies ont réussi et que la source est
        // lisible : une source absente ne doit jamais vider la version (0fa14ea).
        if (
          resumed &&
          !dryRun &&
          chunks.length > 1 &&
          allSucceeded &&
          !this.cancelled &&
          (await readable(part.source))
        ) {
          tracker.copy({ part: part.target, listing: false, current: "" });
          await runRsync(
            { part, dest, linkDest: null, dryRun: false, extraArgs: ["--existing", "--ignore-existing"] },
            { binary, group: this.copyGroup },
          );
        }
        // Total retenu pour la prochaine fois : le comptage complet de la partie ; à défaut, les fichiers vus, sauf
        // en reprise (les fichiers déjà là n'y figurent pas : l'ancien total est gardé).
        const n = counted.get(part.target);
        if (n !== undefined) filesByPart[part.target] = n;
        else if (!resumed) filesByPart[part.target] = seen;
        processed += seen;
        if (this.cancelled) throw BackupError.cancelled();
        if (isPartialTransfer(status)) {
          // Transfert partiel entièrement expliqué par des refus de macOS : compté à part (`permissionDenied`).
          // (rsync GNU ajoute sa ligne de synthèse « some files/attrs were not transferred ».)
          const other = errors.split("\n").filter((l) => l !== "" && !isPartialSummary(l));
          const onlyDenied = other.length === 0 && denied.count > partDenied;
          if (!onlyDenied)
            warnings.push(t("backup.warning.partial", part.target, status) + (errors ? `\n${errors}` : ""));
        } else if (status !== 0) {
          throw BackupError.rsyncFailed(part.target, status, errors);
        }
        bytesByPart[part.target] = partBytes;
        files += partFiles;
        bytes += partBytes;
        tracker.copy({ part: part.target, files, bytes, processed, listing: false, current: "" });
      }
    } finally {
      // Copie finie, annulée ou en échec : le comptage n'a plus d'utilité.
      countGroup.abort();
      await counting;
      this.countGroups.delete(countGroup);
      tracker.countingDone(null);
    }
    // Comptage fini pendant la copie : son total vaut pour toutes les parties.
    for (const [target, n] of counted) filesByPart[target] = n;

    return {
      work,
      versionsDir: dir,
      sources,
      parts,
      manifestExtra: params.manifestExtra ?? {},
      now,
      machine: params.machine,
      partial: params.partial ?? false,
      retention: params.retention,
      dryRun,
      start,
      resumed,
      bytesByPart,
      filesByPart,
      files,
      bytes,
      warnings,
      permissionDenied: denied.value(),
    };
  }

  /**
   * Finalisation d'une copie : empreintes des fichiers nouveaux ou modifiés, manifest, version visible (renommage
   * atomique, `latest` sauf version partielle), rétention. Peut tourner pendant la copie vers une autre destination ;
   * « Arrêter » l'interrompt entre deux fichiers.
   */
  async finish(
    c: CopyResult,
    tracker: DestinationTracker = new DestinationTracker("", c.dryRun),
  ): Promise<BackupOutcome> {
    const outcome = (version: string | null, deleted: string[]): BackupOutcome => ({
      version,
      dryRun: c.dryRun,
      bytesByPart: c.bytesByPart,
      filesByPart: c.filesByPart,
      filesTransferred: c.files,
      bytesTransferred: c.bytes,
      warnings: c.warnings,
      permissionDenied: c.permissionDenied,
      deletedVersions: deleted,
      duration: (Date.now() - c.start) / 1000,
    });
    if (c.dryRun) return outcome(null, []);

    tracker.step("listing");
    await writeChecksums(c.work, c.sources, {
      isCancelled: () => this.cancelled,
      progress: (done, total, current) => tracker.step("checksums", { done, total, current }),
    });
    if (this.cancelled) throw BackupError.cancelled();
    tracker.step("version");
    await writeManifest(c.work, {
      extra: c.manifestExtra,
      date: c.now,
      machine: c.machine,
      macos: await (this.options.macos ?? macOSVersionString)(),
      parts: c.parts,
      bytesTransferred: c.bytes,
      partial: c.partial,
    });

    const name = path.basename(c.work).slice(INCOMPLETE_PREFIX.length);
    await rename(c.work, path.join(c.versionsDir, name));
    if (!c.partial) {
      const latest = path.join(c.versionsDir, LATEST_LINK);
      await unlink(latest).catch(() => {});
      await symlink(name, latest).catch(() => {});
    }
    const deleted = await this.applyRetention(c.versionsDir, c.retention, c.now);
    return outcome(name, deleted);
  }

  /** Supprime les versions hors rétention (seulement après une réussite). */
  async applyRetention(dir: string, retention: Retention, now: Date): Promise<string[]> {
    const keep = this.options.retentionKeep;
    if (!keep) return [];
    const deleted = await excessVersions(dir, retention, now, keep);
    for (const n of deleted) await rm(path.join(dir, n), { recursive: true });
    return deleted;
  }
}
