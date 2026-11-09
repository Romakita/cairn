// Rétention des versions (port de `RetentionPolicy`, Retention.swift, et de `BackupEngine.excessVersions` /
// `uniqueBytes`) : fonctions pures testées avec une horloge simulée, plus la suppression manuelle des versions en
// trop, qui prend le verrou d'opération (design.md §12 : la 0.8.0 ne le prenait pas).
import path from "node:path";
import { excessVersions as engineExcessVersions } from "./backup/engine.ts";
import { dateOfVersion } from "./backup/versions.ts";
import type { Frequency, Retention } from "./config.ts";
import { lstat, readdir, rm } from "./fs-promises.ts";
import { OperationLock, type StatePaths } from "./lock.ts";

const DAY_MS = 86_400 * 1000;

// MARK: Politique

/** Clé de semaine ISO-8601 en UTC (`yearForWeekOfYear-weekOfYear`). */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // lundi = 1… dimanche = 7
  d.setUTCDate(d.getUTCDate() + 4 - weekday); // jeudi de la même semaine : il fixe l'année de la semaine
  const year = d.getUTCFullYear();
  const week = Math.floor((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-${week}`;
}

/**
 * Versions à garder (instants en millisecondes) :
 * - `tiered` : toutes celles de moins de `days` jours, puis la plus récente de chaque semaine ISO (UTC) sur `weeks`
 *   semaines ;
 * - `count` : les `n` plus récentes.
 * La plus récente est toujours gardée.
 */
export function keepVersions(versions: readonly Date[], retention: Retention, now: Date): Set<number> {
  const sorted = versions.map((d) => d.getTime()).sort((a, b) => b - a);
  if (retention.mode === "count") return new Set(sorted.slice(0, Math.max(retention.count, 1)));
  const keep = new Set<number>();
  const dailyLimit = now.getTime() - retention.days * DAY_MS;
  const weeklyLimit = dailyLimit - retention.weeks * 7 * DAY_MS;
  const seenWeeks = new Set<string>();
  for (const t of sorted) {
    if (t >= dailyLimit) {
      keep.add(t);
    } else if (t >= weeklyLimit) {
      const key = isoWeekKey(new Date(t));
      if (!seenWeeks.has(key)) {
        seenWeeks.add(key);
        keep.add(t); // la plus récente de la semaine
      }
    }
  }
  if (sorted.length > 0) keep.add(sorted[0]!);
  return keep;
}

/**
 * La nouvelle rétention peut-elle supprimer des versions que l'ancienne gardait ? (sans lire la destination)
 * Passer d'un type de rétention à l'autre compte comme plus court : on ne peut pas le prouver sans les versions.
 */
export function mayDeleteMore(next: Retention, old: Retention): boolean {
  if (old.mode === "count" && next.mode === "count") return next.count < old.count;
  if (old.mode === "tiered" && next.mode === "tiered") {
    return next.days < old.days || next.days + 7 * next.weeks < old.days + 7 * old.weeks;
  }
  return true;
}

/** Nombre maximal de versions et durée couverte, pour l'affichage dans les réglages. */
export function coverage(retention: Retention, frequency: Frequency): { maxVersions: number; days: number } {
  if (retention.mode === "tiered") {
    const daily = frequency === "daily" ? retention.days : Math.trunc((retention.days + 6) / 7);
    return { maxVersions: daily + retention.weeks, days: retention.days + retention.weeks * 7 };
  }
  const interval = frequency === "weekly" ? 7 : 1;
  return { maxVersions: retention.count, days: retention.count * interval };
}

// MARK: Versions d'une destination montée

/**
 * Versions que la rétention supprimerait (`BackupEngine.excessVersions`, porté dans `backup/engine.ts`) avec cette
 * politique. Une version partielle est en trop dès qu'une version complète plus récente existe.
 */
export function excessVersions(versionsDir: string, retention: Retention, now: Date): Promise<string[]> {
  return engineExcessVersions(versionsDir, retention, now, keepVersions);
}

/**
 * Octets libérés en supprimant ces dossiers : les fichiers ordinaires dont tous les liens physiques sont dedans
 * (`st_blocks × 512`). Les liens symboliques ne sont pas suivis.
 */
export async function uniqueBytes(dirs: readonly string[]): Promise<number> {
  const counts = new Map<string, { seen: number; bytes: number; links: number }>();
  const walk = async (dir: string): Promise<void> => {
    let entries: import("./fs.ts").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      let st: import("./fs.ts").BigIntStats;
      try {
        st = await lstat(p, { bigint: true });
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const key = `${st.dev}:${st.ino}`;
      const c = counts.get(key) ?? { seen: 0, bytes: Number(st.blocks) * 512, links: Number(st.nlink) };
      c.seen += 1;
      counts.set(key, c);
    }
  };
  for (const d of dirs) await walk(d);
  let total = 0;
  for (const c of counts.values()) if (c.seen >= c.links) total += c.bytes;
  return total;
}

// MARK: Changement de rétention dans les réglages

/** Versions en trop lues sur la destination (`null` : destination illisible). */
export type ExcessFound = { names: string[]; bytes: number } | null;

/**
 * Suite d'un changement de rétention (port de `BackupView.change`) :
 * - `apply` : enregistrer, rien ne sera supprimé ;
 * - `confirm` : des versions seraient supprimées, demander confirmation (puis `deleteExcessVersions`) ;
 * - `unreachable` : destination illisible et rétention plus courte, non enregistrée (elle supprimerait des versions
 *   à la prochaine sauvegarde, sans confirmation possible).
 */
export function retentionChangeDecision(
  next: Retention,
  old: Retention,
  found: ExcessFound,
): "apply" | "confirm" | "unreachable" {
  if (found === null) return mayDeleteMore(next, old) ? "unreachable" : "apply";
  return found.names.length === 0 ? "apply" : "confirm";
}

/** Destination ouverte pour la suppression (fourni par `src/core/backup` : `DestinationSession`, sans rien créer). */
export interface OpenedVersions {
  /** `<racine>/cairn/<machine>/versions` de ce Mac. */
  versionsDir: string;
  /** Démonte ce qui a été monté ; `compact` compacte l'image d'abord. */
  close(options: { compact: boolean }): Promise<void>;
}

export interface VersionDeletion {
  deleted: string[];
  /** Noms refusés (pas un nom de version) ou dont la suppression a échoué. */
  failed: string[];
}

/** Opération inscrite dans le verrou pendant la suppression manuelle des versions. */
export const DELETE_VERSIONS_OPERATION = "remove-versions";

/**
 * Supprime les versions confirmées par l'utilisateur, sous le verrou d'opération (refus `OperationLockError` si une
 * sauvegarde, une vérification… tourne), puis compacte l'image. Seuls des noms de version sont acceptés.
 */
export async function deleteExcessVersions(
  paths: StatePaths,
  names: readonly string[],
  open: () => Promise<OpenedVersions>,
): Promise<VersionDeletion> {
  const lock = new OperationLock(paths);
  await lock.acquire(DELETE_VERSIONS_OPERATION);
  try {
    const opened = await open();
    const result: VersionDeletion = { deleted: [], failed: [] };
    try {
      for (const name of names) {
        if (dateOfVersion(name) === null) {
          result.failed.push(name);
          continue;
        }
        try {
          await rm(path.join(opened.versionsDir, name), { recursive: true });
          result.deleted.push(name);
        } catch {
          result.failed.push(name);
        }
      }
    } finally {
      await opened.close({ compact: true });
    }
    return result;
  } finally {
    await lock.release();
  }
}
