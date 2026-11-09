// Brouillon de l'assistant de premier lancement (port de `OnboardingDraft`, Onboarding.swift). Rien n'est écrit sur
// disque : `makeConfig` produit la configuration, que l'appelant enregistre à la fin.
import { lstat, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AIProfile, aiManagedPaths, BUNDLED_PROFILES } from "./ai/profiles.ts";
import { AI_CATEGORIES, type CairnConfig, defaultConfig, destination, type Frequency, folder } from "./config.ts";
import { localizedStandardCompare } from "./path-completion.ts";
import { ALWAYS_REGENERABLE, HOME_EXCLUDES } from "./regenerable.ts";

/** Fichiers de configuration du home proposés s'ils existent (les dossiers des outils IA sont gérés à part). */
export const HOME_CANDIDATES: readonly string[] = [
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".gitconfig",
  ".gitignore_global",
  ".ssh",
  ".aws",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".yarnrc",
  ".netrc",
  ".config/mise",
  ".config/gh",
  ".config/git",
  ".config/starship.toml",
  ".oh-my-zsh/custom",
  ".zsh_history",
  ".gnupg",
];

/** Identifiant de la destination créée par l'assistant. */
export const ONBOARDING_DESTINATION_ID = "main";

export interface OnboardingChoice {
  path: string;
  selected: boolean;
}

export interface AIChoice {
  id: string;
  detected: boolean;
  categories: Set<string>;
}

export type DestinationChoice =
  | { kind: "later" }
  | { kind: "local"; path: string }
  | { kind: "smb"; url: string; username: string };

export interface OnboardingDraft {
  folders: OnboardingChoice[];
  home: OnboardingChoice[];
  ai: AIChoice[];
  destination: DestinationChoice;
  encrypted: boolean;
  frequency: Frequency;
  time: string;
  weekday: string;
  background: boolean;
  language: string;
}

export function emptyDraft(): OnboardingDraft {
  return {
    folders: [],
    home: [],
    ai: [],
    destination: { kind: "later" },
    encrypted: true,
    frequency: "daily",
    time: "12:30",
    weekday: "monday",
    background: false,
    language: "auto",
  };
}

type Exists = (p: string) => boolean | Promise<boolean>;
type FolderLister = (home: string) => readonly string[] | Promise<readonly string[]>;

/** Comme `fileExists` : suit les liens symboliques. */
async function defaultExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listFolders(home: string, keep: (name: string) => boolean): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(home);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!keep(name)) continue;
    try {
      // Sans suivre les liens symboliques.
      if ((await lstat(path.join(home, name))).isDirectory()) out.push(name);
    } catch {
      // disparu entre-temps
    }
  }
  return out;
}

/** Dossiers cachés à la racine du home (sans suivre les liens symboliques). */
export function listHiddenFolders(home: string): Promise<string[]> {
  return listFolders(home, (n) => n.startsWith(".") && n !== "." && n !== "..");
}

/** Dossiers visibles à la racine du home, sans `Library` ni liens symboliques. */
export function listVisibleFolders(home: string): Promise<string[]> {
  return listFolders(home, (n) => !n.startsWith(".") && n !== "Library");
}

/** Clé de tri : sans le point initial, pour ranger `.aws` avec les `a`. */
function sortKey(p: string): string {
  return p.startsWith(".") ? p.slice(1) : p;
}

function byHomeName(a: string, b: string): number {
  return localizedStandardCompare(sortKey(a), sortKey(b));
}

/** Dossiers cachés jamais proposés : outils IA (gérés à part), caches et corbeille, dossier de Cairn. */
export function homeSkipped(name: string, profiles: readonly AIProfile[]): boolean {
  if (name === ".cairn" || Object.hasOwn(ALWAYS_REGENERABLE, name)) return true;
  const excludes = HOME_EXCLUDES.map((e) => (e.endsWith("/") ? e.slice(0, -1) : e));
  if (excludes.includes(name)) return true;
  return aiManagedPaths(profiles).includes(name);
}

/** Éléments du home sans doublons, triés par nom sans le point initial. */
export function sortedHomeItems(items: readonly string[]): string[] {
  return [...new Set(items)].sort(byHomeName);
}

export interface HomeChoicesOptions {
  home?: string;
  exists?: Exists;
  hiddenFolders?: FolderLister;
  visibleFolders?: FolderLister;
  profiles?: readonly AIProfile[];
}

async function knownCandidates(home: string, exists: Exists): Promise<string[]> {
  const out: string[] = [];
  for (const c of HOME_CANDIDATES) if (await exists(path.join(home, c))) out.push(c);
  return out;
}

/**
 * Éléments du home proposés dans les réglages, triés par nom (sans le point initial) : ceux déjà sauvegardés, les
 * fichiers de configuration connus présents, et tous les dossiers cachés ou visibles de la racine du home (hors
 * outils IA, caches et corbeille).
 */
export async function homeChoices(include: readonly string[], options: HomeChoicesOptions = {}): Promise<string[]> {
  const home = options.home ?? os.homedir();
  const profiles = options.profiles ?? BUNDLED_PROFILES;
  const known = await knownCandidates(home, options.exists ?? defaultExists);
  const hidden = await (options.hiddenFolders ?? listHiddenFolders)(home);
  const visible = await (options.visibleFolders ?? listVisibleFolders)(home);
  const folders = [...hidden, ...visible].filter((n) => !homeSkipped(n, profiles));
  return sortedHomeItems([...include, ...known, ...folders]);
}

export interface DetectOptions {
  home?: string;
  /** Ancien dossier de l'app (présélectionné). */
  legacyRootPath?: string | null;
  exists?: Exists;
  hiddenFolders?: FolderLister;
  profiles?: readonly AIProfile[];
}

/** Propositions détectées sur la machine (lecture seule). */
export async function detectDraft(options: DetectOptions = {}): Promise<OnboardingDraft> {
  const home = options.home ?? os.homedir();
  const exists = options.exists ?? defaultExists;
  const profiles = options.profiles ?? BUNDLED_PROFILES;
  const legacy = options.legacyRootPath ?? null;
  const d = emptyDraft();

  const seen = new Set<string>();
  const fixed = ["/Volumes/workspaces", ...(legacy ? [legacy] : [])];
  const candidates = [
    ...fixed,
    ...["Projects", "Projets", "Developer", "workspace", "code"].map((n) => path.join(home, n)),
  ];
  // Présélection : /Volumes/workspaces et l'ancien dossier de l'app, repérés par leur chemin (pas leur rang).
  const preselected = new Set(fixed);
  for (const p of candidates) {
    if (seen.has(p) || !(await exists(p))) continue;
    seen.add(p);
    d.folders.push({ path: p, selected: preselected.has(p) });
  }
  if (!d.folders.some((f) => f.selected) && d.folders.length > 0) d.folders[0]!.selected = true;

  // Fichiers connus (cochés) puis tous les autres dossiers cachés du home (à cocher), triés par nom.
  const known = await knownCandidates(home, exists);
  const others = (await (options.hiddenFolders ?? listHiddenFolders)(home)).filter(
    (n) => !known.includes(n) && !homeSkipped(n, profiles),
  );
  d.home = [
    ...known.map((p) => ({ path: p, selected: true })),
    ...others.map((p) => ({ path: p, selected: false })),
  ].sort((a, b) => byHomeName(a.path, b.path));

  // Outils IA : un par profil ; présélection des catégories que l'outil remplit vraiment (pas d'« identifiants » pour
  // un outil qui les range dans le Trousseau).
  for (const p of profiles) {
    let found = false;
    for (const x of p.detect) {
      if (await exists(path.join(home, x))) {
        found = true;
        break;
      }
    }
    const cats = AI_CATEGORIES.filter((c) => (p.categories[c]?.length ?? 0) > 0);
    d.ai.push({ id: p.id, detected: found, categories: new Set(found ? cats : []) });
  }
  return d;
}

/** Les identifiants ne sont cochés que si la destination est chiffrée. */
export function effectiveAI(d: OnboardingDraft): AIChoice[] {
  return d.ai.map((c) => {
    const categories = new Set(c.categories);
    if (!d.encrypted || d.destination.kind === "later") categories.delete("credentials");
    return { ...c, categories };
  });
}

/** Configuration produite par l'assistant. */
export function makeConfig(d: OnboardingDraft): CairnConfig {
  const c = defaultConfig();
  c.language = d.language;
  c.folders = d.folders.filter((f) => f.selected).map((f) => folder(f.path));
  c.home.include = d.home.filter((h) => h.selected).map((h) => h.path);
  c.ai = effectiveAI(d)
    .filter((a) => a.detected)
    .map((a) => ({ id: a.id, categories: AI_CATEGORIES.filter((cat) => a.categories.has(cat)) }));
  switch (d.destination.kind) {
    case "later":
      break;
    case "local":
      c.destinations = [
        destination(ONBOARDING_DESTINATION_ID, "local", { path: d.destination.path, encrypted: d.encrypted }),
      ];
      break;
    case "smb":
      // Pas de clé `keychain` : l'entrée du Trousseau se déduit de l'hôte de `url` et de `username`.
      c.destinations = [
        destination(ONBOARDING_DESTINATION_ID, "smb", {
          url: d.destination.url,
          username: d.destination.username,
          encrypted: d.encrypted,
        }),
      ];
      break;
  }
  c.schedule.frequency = d.frequency;
  c.schedule.time = d.time;
  c.schedule.weekday = d.weekday;
  c.schedule.background = d.background;
  return c;
}
