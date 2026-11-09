// Profils déclaratifs des outils IA (`resources/ai-tools/<id>.json`, copiés tels quels de la 0.8.0).
// Ajouter un outil = ajouter un profil (et son import ci-dessous) ; `loadProfiles` lit un dossier sans recompiler.
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import claudeCode from "../../../resources/ai-tools/claude-code.json" with { type: "json" };
import claudeDesktop from "../../../resources/ai-tools/claude-desktop.json" with { type: "json" };
import codex from "../../../resources/ai-tools/codex.json" with { type: "json" };
import { t } from "../l10n.ts";

export interface AIProfile {
  id: string;
  /** Nom affiché (nom de produit, non traduit). Absent : clé `ai.<id>` des traductions. */
  name?: string;
  version: number;
  /** Racine des données (`~` développé), chemins des catégories relatifs à elle. */
  root: string;
  /** Chemins relatifs au home qui signalent la présence de l'outil. */
  detect: string[];
  /** Jeton rangé dans le Trousseau : reconnexion nécessaire après restauration. */
  credentials_in_keychain: boolean;
  conversations_glob?: string;
  categories: Record<string, string[]>;
  sqlite: string[];
  exclude: string[];
  reinstall: string[];
  /** Noms de processus de l'outil : il doit être quitté avant une restauration. */
  processes?: string[];
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Décode un profil comme `JSONDecoder` : champ obligatoire absent ou mal typé → null. */
export function decodeProfile(obj: unknown): AIProfile | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.root !== "string" || typeof o.credentials_in_keychain !== "boolean") {
    return null;
  }
  if (typeof o.version !== "number" || !Number.isInteger(o.version)) return null;
  if (!isStrings(o.detect) || !isStrings(o.sqlite) || !isStrings(o.exclude) || !isStrings(o.reinstall)) return null;
  if (o.categories === null || typeof o.categories !== "object" || Array.isArray(o.categories)) return null;
  const categories: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(o.categories)) {
    if (!isStrings(v)) return null;
    categories[k] = v;
  }
  if (o.name !== undefined && o.name !== null && typeof o.name !== "string") return null;
  if (o.conversations_glob !== undefined && o.conversations_glob !== null && typeof o.conversations_glob !== "string") {
    return null;
  }
  if (o.processes !== undefined && o.processes !== null && !isStrings(o.processes)) return null;
  const p: AIProfile = {
    id: o.id,
    version: o.version,
    root: o.root,
    detect: o.detect,
    credentials_in_keychain: o.credentials_in_keychain,
    categories,
    sqlite: o.sqlite,
    exclude: o.exclude,
    reinstall: o.reinstall,
  };
  if (typeof o.name === "string") p.name = o.name;
  if (typeof o.conversations_glob === "string") p.conversations_glob = o.conversations_glob;
  if (isStrings(o.processes)) p.processes = o.processes;
  return p;
}

const byId = (a: AIProfile, b: AIProfile) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Profils fournis avec Cairn, triés par identifiant. */
export const BUNDLED_PROFILES: readonly AIProfile[] = [claudeCode, claudeDesktop, codex]
  .map(decodeProfile)
  .filter((p): p is AIProfile => p !== null)
  .sort(byId);

/** Profils d'un dossier (ajout d'un outil sans recompiler, tests). */
export async function loadProfiles(dir: string): Promise<AIProfile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: AIProfile[] = [];
  for (const n of names) {
    if (path.extname(n) !== ".json") continue;
    try {
      const p = decodeProfile(JSON.parse(await readFile(path.join(dir, n), "utf8")));
      if (p) out.push(p);
    } catch {}
  }
  return out.sort(byId);
}

/** Racine des données de l'outil pour ce home. */
export function rootPath(p: AIProfile, home: string = os.homedir()): string {
  if (p.root === "~") return home;
  return p.root.startsWith("~/") ? `${home}/${p.root.slice(2)}` : p.root;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Détecté si l'un des chemins `detect` (relatifs au home) existe. */
export async function isDetected(p: AIProfile, home: string = os.homedir()): Promise<boolean> {
  for (const d of p.detect) if (await exists(`${home}/${d}`)) return true;
  return false;
}

export function displayName(p: AIProfile): string {
  return p.name ?? t(`ai.${p.id}`);
}

/** Nom affiché d'un outil d'après son identifiant. */
export function profileName(id: string, profiles: readonly AIProfile[] = BUNDLED_PROFILES): string {
  const p = profiles.find((x) => x.id === id);
  return p ? displayName(p) : t(`ai.${id}`);
}

/** Chemins relatifs au home occupés par l'outil (racine et marqueurs de détection). */
export function homePaths(p: AIProfile): string[] {
  const out: string[] = [];
  if (p.root.startsWith("~/")) out.push(p.root.slice(2));
  for (const d of p.detect) if (!out.includes(d)) out.push(d);
  return out;
}

/** Racines `~/…` et chemins `detect` des profils, retirés de la sélection du home (`BackupExclusions.aiManaged`). */
export function aiManagedPaths(profiles: readonly AIProfile[] = BUNDLED_PROFILES): string[] {
  const out: string[] = [];
  for (const p of profiles) for (const h of homePaths(p)) if (!out.includes(h)) out.push(h);
  return out;
}
