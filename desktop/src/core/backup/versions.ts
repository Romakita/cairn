// Versions sur une destination montée (port des fonctions statiques de `BackupEngine`) :
// `<racine>/cairn/<machine>/versions/<yyyy-MM-ddTHHmmss>/`, `.incomplete-<nom>/`, lien `latest`.
// Les noms et l'arborescence sont ceux de la 0.8.0 (parity/behavior.md §3.9) : une version écrite par l'une est
// relue par l'autre.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { formatLocalDate } from "../dates.ts";
import type { BackupPart } from "./types.ts";

/** Format des noms de version (heure locale, `en_US_POSIX`, triable). */
export const VERSION_FORMAT = "yyyy-MM-dd'T'HHmmss";
export const INCOMPLETE_PREFIX = ".incomplete-";
/** Une version incomplète plus vieille que ça est jetée (`maxResumeAge`). */
export const MAX_RESUME_AGE_MS = 7 * 86_400_000;
export const LATEST_LINK = "latest";
export const MANIFEST_FILE = "manifest.json";

/** Nom de version d'une date (heure locale). */
export function versionName(date: Date): string {
  return formatLocalDate(date, VERSION_FORMAT);
}

/** Date d'un nom de version (heure locale), `null` si le nom n'en est pas un (comme `DateFormatter` strict). */
export function dateOfVersion(name: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, s);
  // Refus des dates impossibles (mois 13, 31 février…) : le formateur ne les accepte pas non plus.
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== mi ||
    date.getSeconds() !== s
  ) {
    return null;
  }
  return date;
}

/** Dossier des versions d'une machine sur une destination montée. */
export function versionsDir(root: string, machine: string): string {
  return path.join(root, "cairn", machine, "versions");
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Versions terminées, de la plus ancienne à la plus récente. */
export async function listVersions(dir: string): Promise<string[]> {
  return (await entries(dir))
    .filter((n) => !n.startsWith(".") && n !== LATEST_LINK && dateOfVersion(n) !== null)
    .sort(compareNames);
}

/** Versions de travail (`.incomplete-…`), triées. */
export async function listIncomplete(dir: string): Promise<string[]> {
  return (await entries(dir)).filter((n) => n.startsWith(INCOMPLETE_PREFIX)).sort(compareNames);
}

/** Ordre des points de code (comme `String <` pour ces noms ASCII). */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Manifest d'une version, ou `null` s'il est absent ou illisible. */
export async function readManifest(version: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(version, MANIFEST_FILE), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Version partielle (`--only`, `--tool`) : elle ne sert ni de base aux suivantes, ni de « latest », ni de version par
 * défaut à la restauration, et la rétention ne la compte pas.
 */
export async function isPartial(version: string): Promise<boolean> {
  return (await readManifest(version))?.partial === true;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Pour chaque partie, la version la plus récente qui la contient (base de `--link-dest` et des empreintes). */
export async function linkSources(parts: readonly BackupPart[], dir: string): Promise<Record<string, string>> {
  const all = (await listVersions(dir)).reverse().map((v) => path.join(dir, v));
  const out: Record<string, string> = {};
  for (const part of parts) {
    for (const v of all) {
      if (await exists(path.join(v, part.target))) {
        out[part.target] = v;
        break;
      }
    }
  }
  return out;
}

/** Journaux cités par les manifests des versions présentes (épargnés par la purge : `keptLogs`). */
export async function versionLogs(dir: string): Promise<string[]> {
  const logs: string[] = [];
  for (const v of await listVersions(dir)) {
    const log = (await readManifest(path.join(dir, v)))?.log;
    if (typeof log === "string") logs.push(log);
  }
  return logs.sort(compareNames);
}
