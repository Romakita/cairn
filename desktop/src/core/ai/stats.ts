// Vue IA et `cairn ai --json` (port d'`AIBackup.stats` et `lastBackup`) : tailles par catégorie, part non copiée,
// conversations, dernière sauvegarde.
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import { dateOfVersion, listVersions, readManifest, versionsDir } from "../backup/versions.ts";
import type { CairnConfig } from "../config.ts";
import { isoDate } from "../dates.ts";
import { type JSONValue, prettyJSON } from "../json.ts";
import { expandTilde } from "../paths.ts";
import { measure as scannerMeasure } from "../scanner.ts";
import { expandEntries } from "./backup.ts";
import { globMatch } from "./glob.ts";
import { type AIProfile, BUNDLED_PROFILES, isDetected, rootPath } from "./profiles.ts";

/** Taille d'un chemin (fichier ou dossier) : `Scanner.measure`. */
export type Measure = (path: string) => Promise<{ size: number }>;

export const defaultMeasure: Measure = (p) => scannerMeasure(p);

export interface ToolStats {
  profile: AIProfile;
  detected: boolean;
  bytesByCategory: Record<string, number>;
  notCopiedBytes: number;
  totalBytes: number;
  conversations: number;
  latestConversation: Date | null;
  /** Dernière sauvegarde réussie de l'outil (remplie par l'appelant, voir `lastBackup`). */
  lastBackup?: Date | null;
}

/** Taille de ce qui sera sauvegardé : somme des catégories cochées. */
export function bytesOf(s: ToolStats, categories: readonly string[]): number {
  let total = 0;
  for (const c of new Set(categories)) total += s.bytesByCategory[c] ?? 0;
  return total;
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function sizeOf(paths: readonly string[], measure: Measure): Promise<number> {
  let total = 0;
  for (const p of paths) total += (await measure(p)).size;
  return total;
}

/** Tailles par catégorie, conversations et éléments non copiés (pour la vue IA et `cairn ai`). */
export async function toolStats(
  p: AIProfile,
  home: string = os.homedir(),
  measure: Measure = defaultMeasure,
): Promise<ToolStats> {
  const s: ToolStats = {
    profile: p,
    detected: await isDetected(p, home),
    bytesByCategory: {},
    notCopiedBytes: 0,
    totalBytes: 0,
    conversations: 0,
    latestConversation: null,
  };
  if (!s.detected) return s;
  const root = rootPath(p, home);
  for (const [cat, entries] of Object.entries(p.categories)) {
    s.bytesByCategory[cat] = await sizeOf(
      (await expandEntries(entries, root)).map((e) => `${root}/${e}`),
      measure,
    );
  }
  s.notCopiedBytes = await sizeOf(
    (await expandEntries(p.reinstall, root)).map((e) => `${root}/${e}`),
    measure,
  );
  s.totalBytes =
    p.root !== "~"
      ? (await measure(root)).size
      : await sizeOf(
          p.detect.map((d) => `${home}/${d}`),
          measure,
        );
  if (p.conversations_glob) {
    // Motif segment par segment (`sessions/*/*/*/rollout-*`).
    let paths = [""];
    for (const part of p.conversations_glob.split("/").filter((x) => x !== "")) {
      const next: string[] = [];
      for (const base of paths) {
        const dir = base === "" ? root : `${root}/${base}`;
        for (const name of await list(dir))
          if (globMatch(part, name)) next.push(base === "" ? name : `${base}/${name}`);
      }
      paths = next;
    }
    s.conversations = paths.length;
    let latest: number | null = null;
    for (const rel of paths) {
      try {
        const m = (await stat(`${root}/${rel}`)).mtimeMs;
        if (latest === null || m > latest) latest = m;
      } catch {}
    }
    s.latestConversation = latest === null ? null : new Date(latest);
  }
  return s;
}

/** Dernières réussites par destination (`RunState`). */
export interface LastSuccessState {
  destinations: Record<string, { lastSuccess?: Date | null } | undefined>;
}

/**
 * Dernière sauvegarde réussie d'un outil. Sur les destinations locales non chiffrées déjà accessibles (lecture seule,
 * rien n'est monté), date de la dernière version dont le manifest contient `ai/<outil>/…` ; sinon, si l'outil est
 * configuré, dernière réussite enregistrée parmi les destinations.
 */
export async function lastBackup(
  toolID: string,
  config: CairnConfig,
  state: LastSuccessState,
  machine: string,
): Promise<Date | null> {
  let found: Date | null = null;
  for (const d of config.destinations) {
    if (d.provider !== "local" || d.encrypted) continue;
    const p = expandTilde(d.path ?? "");
    if (p === "") continue;
    try {
      await stat(p);
    } catch {
      continue;
    }
    const dir = versionsDir(p, machine);
    for (const v of (await listVersions(dir)).reverse()) {
      const m = await readManifest(`${dir}/${v}`);
      const parts = m?.parts;
      if (!Array.isArray(parts)) continue;
      const has = parts.some((x) => {
        const target = (x as Record<string, unknown> | null)?.target;
        return typeof target === "string" && target.startsWith(`ai/${toolID}/`);
      });
      const date = dateOfVersion(v);
      if (!has || date === null) continue;
      if (found === null || date > found) found = date;
      break;
    }
  }
  if (found) return found;
  if (!config.ai.some((a) => a.id === toolID && a.categories.length > 0)) return null;
  let best: Date | null = null;
  for (const d of config.destinations) {
    const when = state.destinations[d.id]?.lastSuccess;
    if (when && (best === null || when > best)) best = when;
  }
  return best;
}

/** Données de `cairn ai --json` pour un outil (format de la 0.8.0). */
export function toolStatsJSON(s: ToolStats, config: CairnConfig): JSONValue {
  return {
    id: s.profile.id,
    detected: s.detected,
    bytes_by_category: s.bytesByCategory,
    not_copied_bytes: s.notCopiedBytes,
    total_bytes: s.totalBytes,
    conversations: s.conversations,
    latest_conversation: s.latestConversation ? isoDate(s.latestConversation) : null,
    selected_categories: config.ai.find((a) => a.id === s.profile.id)?.categories ?? [],
    credentials_in_keychain: s.profile.credentials_in_keychain,
  };
}

/** Statistiques de tous les profils. */
export async function allToolStats(
  home: string = os.homedir(),
  profiles: readonly AIProfile[] = BUNDLED_PROFILES,
  measure: Measure = defaultMeasure,
): Promise<ToolStats[]> {
  const out: ToolStats[] = [];
  for (const p of profiles) out.push(await toolStats(p, home, measure));
  return out;
}

/** Sortie de `cairn ai --json`. */
export function aiJSON(stats: readonly ToolStats[], config: CairnConfig): string {
  return prettyJSON({ tools: stats.map((s) => toolStatsJSON(s, config)) });
}
