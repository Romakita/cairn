// Classement « régénérable » : une seule source pour l'analyse du disque (port de `Scanner.alwaysRegenerable`,
// `Scanner.conditional`, `Category`) et pour les exclusions de la sauvegarde (port de `BackupExclusions`).
// Voir parity/behavior.md §3.1 : les tables sont reprises telles quelles.
import path from "node:path";
import { access, lstat, readdir } from "./fs-promises.ts";
import { t } from "./l10n.ts";
import { run } from "./process.ts";

// MARK: Catégories

/** Type de contenu d'un dossier. Tout ce qui n'est pas `source` est compté en bloc (on n'y descend pas dans l'arbre). */
export const CATEGORIES = ["source", "git", "deps", "build", "ios", "python", "cache", "trash"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Rang de la catégorie (`Category.rawValue`) : index dans `CATEGORIES` et dans `Node.breakdown`. */
export function categoryIndex(c: Category): number {
  return CATEGORIES.indexOf(c);
}

/** Peut être supprimé puis recréé (npm install, build, pod install…) : ni `.git` ni la corbeille. */
export function isRegenerable(c: Category): boolean {
  return c === "deps" || c === "build" || c === "ios" || c === "python" || c === "cache";
}

export const REGENERABLE_CATEGORIES: readonly Category[] = CATEGORIES.filter(isRegenerable);

export function categoryLabel(c: Category): string {
  return t(`category.${c}.label`);
}

export function categoryShortLabel(c: Category): string {
  return t(`category.${c}.short`);
}

// MARK: Règles

/** Nom de dossier → catégorie, quel que soit l'endroit. */
export const ALWAYS_REGENERABLE: Readonly<Record<string, Category>> = Object.freeze({
  ".git": "git",
  node_modules: "deps",
  bower_components: "deps",
  jspm_packages: "deps",
  Pods: "ios",
  DerivedData: "ios",
  Carthage: "ios",
  dist: "build",
  coverage: "build",
  ".next": "build",
  ".nuxt": "build",
  ".angular": "build",
  ".turbo": "build",
  ".nx": "build",
  ".vite": "build",
  ".parcel-cache": "build",
  ".svelte-kit": "build",
  ".output": "build",
  "storybook-static": "build",
  ".docusaurus": "build",
  ".expo": "build",
  ".venv": "python",
  venv: "python",
  __pycache__: "python",
  ".pytest_cache": "python",
  ".mypy_cache": "python",
  ".ruff_cache": "python",
  ".tox": "python",
  ".cache": "cache",
  ".npm-cache": "cache",
  ".pnpm-store": "cache",
  ".eslintcache": "cache",
  ".sass-cache": "cache",
  ".Trashes": "trash",
  ".Trash": "trash",
});

/** Dossiers génériques considérés comme générés seulement à côté d'un fichier de projet (dans le dossier parent). */
export const CONDITIONAL_REGENERABLE: Readonly<Record<string, readonly [Category, readonly string[]]>> = Object.freeze({
  build: [
    "build",
    ["package.json", "build.gradle", "build.gradle.kts", "settings.gradle", "CMakeLists.txt", "pubspec.yaml"],
  ],
  out: ["build", ["package.json", "tsconfig.json"]],
  target: ["build", ["Cargo.toml", "pom.xml"]],
  ".gradle": ["build", ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"]],
  vendor: ["deps", ["composer.json", "Gemfile", "go.mod"]],
  ".build": ["build", ["Package.swift"]],
});

/**
 * Dossiers régénérables reconnus par leur chemin (fin du chemin, à n'importe quelle profondeur) : leur nom seul est
 * trop générique (`_cacache`, `cache`). Caches des gestionnaires de paquets.
 */
export const NESTED_REGENERABLE: Readonly<Record<string, Category>> = Object.freeze({
  ".npm/_cacache": "cache",
  ".bun/install/cache": "cache",
});

/** Tables passées telles quelles aux workers d'analyse (données clonables). */
export interface ClassificationRules {
  always: Readonly<Record<string, Category>>;
  nested: Readonly<Record<string, Category>>;
  conditional: Readonly<Record<string, readonly [Category, readonly string[]]>>;
}

export const CLASSIFICATION_RULES: ClassificationRules = {
  always: ALWAYS_REGENERABLE,
  nested: NESTED_REGENERABLE,
  conditional: CONDITIONAL_REGENERABLE,
};

/**
 * Classement d'un dossier d'après son nom et son parent. Fonction autonome (elle n'utilise que ses paramètres) :
 * le worker d'analyse en reçoit le texte (`classifyWith.toString()`), pour garder une seule implémentation.
 */
export function classifyWith(
  rules: ClassificationRules,
  exists: (file: string) => boolean,
  name: string,
  parentPath: string,
): Category {
  if (Object.hasOwn(rules.always, name)) return rules.always[name] as Category;
  for (const suffix in rules.nested) {
    // Comparaison sans allocation tant que le dernier segment ne correspond pas (chemin chaud du worker).
    const cut = suffix.lastIndexOf("/");
    if (suffix.length - cut - 1 !== name.length || !suffix.endsWith(name)) continue;
    const parent = suffix.slice(0, cut);
    if (parentPath === parent || parentPath.endsWith(`/${parent}`)) return rules.nested[suffix] as Category;
  }
  if (Object.hasOwn(rules.conditional, name)) {
    const [category, markers] = rules.conditional[name] as readonly [Category, readonly string[]];
    for (const m of markers) if (exists(`${parentPath}/${m}`)) return category;
  }
  return "source";
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const never = () => false;

/** `Scanner.classify`, asynchrone (les marqueurs des noms génériques sont cherchés avec `fs/promises`). */
export async function classify(name: string, parentPath: string): Promise<Category> {
  // Noms et chemins : même code que les workers ; seuls les marqueurs des noms génériques sont cherchés ici.
  // Sans marqueur trouvé (`never`), la règle conditionnelle retombe sur "source" : elle est traitée juste après.
  const known = classifyWith(CLASSIFICATION_RULES, never, name, parentPath);
  if (known !== "source") return known;
  if (Object.hasOwn(CONDITIONAL_REGENERABLE, name)) {
    const [category, markers] = CONDITIONAL_REGENERABLE[name] as readonly [Category, readonly string[]];
    for (const m of markers) if (await fileExists(`${parentPath}/${m}`)) return category;
  }
  return "source";
}

// MARK: Sauvegarde (BackupExclusions)

/** Métadonnées de volume, ancrées à la racine d'un dossier suivi. */
export const VOLUME_METADATA: readonly string[] = [
  "/.Spotlight-V100/",
  "/.fseventsd/",
  "/.Trashes/",
  "/.TemporaryItems/",
  "/.DocumentRevisions-V100/",
];

const EXTRA_PATTERNS = [".nyc_output/", ".stylelintcache", ".eslintcache", "*.tsbuildinfo", ".terraform/", ".DS_Store"];

/**
 * Applications, qui se réinstallent : exclues des sauvegardes de dossiers (paquets `*.app` partout, `Applications` à
 * la racine du dossier suivi), mais jamais classées régénérables (l'analyse ne les propose pas au nettoyage).
 */
export const APPLICATION_PATTERNS: readonly string[] = ["/Applications/", "*.app/"];

/**
 * Motifs rsync exclus partout, dans cet ordre : métadonnées de volume, noms toujours régénérables (catégories
 * régénérables seulement : ni `.git/`, l'historique est sauvegardé, ni `.Trash/`), triés, chemins régénérables
 * (`.npm/_cacache/`… : un motif rsync avec `/` non ancré vaut à toute profondeur), extras, puis applications.
 */
export function staticPatterns(): string[] {
  const regenerable = Object.keys(ALWAYS_REGENERABLE)
    .filter((name) => isRegenerable(ALWAYS_REGENERABLE[name] as Category))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => `${name}/`);
  const nested = Object.keys(NESTED_REGENERABLE).map((p) => `${p}/`);
  return [...VOLUME_METADATA, ...regenerable, ...nested, ...EXTRA_PATTERNS, ...APPLICATION_PATTERNS];
}

/** Noms génériques exclus de la sauvegarde seulement s'ils sont générés. */
export const GENERIC_NAMES: ReadonlySet<string> = new Set([
  "lib",
  "build",
  "out",
  "target",
  "tmp",
  "temp",
  ".tmp",
  "vendor",
  ".build",
  ".gradle",
]);

/** Dossiers où la détection ne descend pas. */
const WALK_SKIP: ReadonlySet<string> = new Set([...Object.keys(ALWAYS_REGENERABLE), ".git"]);
const NESTED_SUFFIXES: readonly string[] = Object.keys(NESTED_REGENERABLE).map((n) => `/${n}`);

/**
 * Un dossier générique est-il généré ? Dans un dépôt git : seulement s'il est ignoré (`git check-ignore`).
 * Hors dépôt, ces règles diffèrent volontairement de `CONDITIONAL_REGENERABLE` (comme la 0.8.0, §3.1) :
 * `lib` exige `package.json` et `src`, `vendor` accepte `composer.lock`, `tmp`/`temp`/`.tmp` sont toujours exclus.
 */
export async function isGenerated(name: string, parent: string, inRepo: boolean): Promise<boolean> {
  if (inRepo) {
    const r = await run("/usr/bin/git", ["-C", parent, "check-ignore", "-q", `${name}/`], {
      stderr: "ignore",
      captureStdout: false,
      extraEnv: { GIT_TERMINAL_PROMPT: "0" },
    });
    return r.code === 0;
  }
  const has = (f: string) => fileExists(`${parent}/${f}`);
  const any = async (files: string[]) => {
    for (const f of files) if (await has(f)) return true;
    return false;
  };
  switch (name) {
    case "lib":
      return (await has("package.json")) && (await has("src"));
    case "build":
    case "out":
      return any(["package.json", "build.gradle", "build.gradle.kts", "CMakeLists.txt"]);
    case "target":
      return any(["Cargo.toml", "pom.xml"]);
    case "vendor":
      return any(["composer.lock", "composer.json", "Gemfile", "go.mod"]);
    case ".build":
      return has("Package.swift");
    case ".gradle":
      return any(["build.gradle", "build.gradle.kts", "settings.gradle", "gradlew"]);
    default:
      return true; // tmp, temp, .tmp
  }
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface DetectOptions {
  /** Parcours abandonné dès que le signal est levé (« Arrêter » pendant la préparation d'une sauvegarde). */
  signal?: AbortSignal;
  /** Reçoit chaque dossier parcouru (relatif à `root`, `""` pour la racine), pour afficher l'avancement. */
  visiting?: (relative: string) => void;
}

/**
 * Dossiers génériques générés trouvés dans `root`, en chemins ancrés pour rsync (`/a/b/build/`). Parcours trié, sans
 * suivre les liens, sans descendre dans les dossiers toujours régénérables, `.git` ni les métadonnées de volume ;
 * un dossier détecté n'est pas parcouru.
 */
export async function detectGenerated(root: string, options: DetectOptions = {}): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, inRepo: boolean): Promise<void> => {
    if (options.signal?.aborted) return;
    options.visiting?.(dir === root ? "" : dir.slice(root.length + 1));
    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }
    const repoHere = inRepo || items.includes(".git");
    for (const item of items.sort(compareNames)) {
      if (options.signal?.aborted) return;
      const p = `${dir}/${item}`;
      // `fileExists(isDirectory:)` suit les liens, puis on écarte les liens : reste un vrai dossier.
      const st = await lstat(p).catch(() => null);
      if (!st?.isDirectory()) continue;
      if (WALK_SKIP.has(item) || VOLUME_METADATA.includes(`/${item}/`)) continue;
      if (NESTED_SUFFIXES.some((n) => p.endsWith(n))) continue;
      if (GENERIC_NAMES.has(item) && (await isGenerated(item, dir, repoHere))) {
        found.push(`/${p.slice(root.length + 1)}/`);
        continue;
      }
      await walk(p, repoHere);
    }
  };
  await walk(root, false);
  return found;
}

/** Liste complète d'un dossier suivi : statique, générée, motifs de l'utilisateur, destinations situées dessous. */
export async function excludesForFolder(
  root: string,
  userPatterns: readonly string[],
  destinations: readonly string[],
  options: DetectOptions = {},
): Promise<string[]> {
  const list = [...staticPatterns(), ...(await detectGenerated(root, options)), ...userPatterns];
  for (const d of destinations) if (d.startsWith(`${root}/`)) list.push(`/${d.slice(root.length + 1)}/`);
  return list;
}

// MARK: Home

/** Profil IA vu par la sauvegarde du home : chemins relatifs au home occupés par l'outil (racine et marqueurs). */
export interface AIHomePaths {
  homePaths: readonly string[];
}

/** Dossiers des outils IA : sauvegardés par la partie IA, jamais par la sélection du home. */
export function aiManaged(profiles: readonly AIHomePaths[]): string[] {
  const out: string[] = [];
  for (const p of profiles) for (const item of p.homePaths) if (!out.includes(item)) out.push(item);
  return out;
}

/** Caches et installations reconstructibles, exclus même dans un élément sélectionné du home. */
export const HOME_EXCLUDES: readonly string[] = [
  ".cache/",
  "cache/",
  "Cache/",
  "Caches/",
  "logs/",
  "*.log",
  "node_modules/",
  ".DS_Store",
  ".npm/",
  ".bun/install/cache/",
  ".yarn/berry/cache/",
  ".pnpm-store/",
  ".local/share/pnpm/store/",
  ".local/share/mise/installs/",
  ".local/share/mise/downloads/",
  ".local/share/uv/tools/",
  ".local/share/uv/python/",
  ".local/pipx/venvs/",
  ".local/pipx/shared/",
  ".local/pipx/.cache/",
  ".ollama/models/",
  ".gradle/caches/",
  ".m2/repository/",
  ".cargo/registry/",
  ".rustup/toolchains/",
  ".composer/cache/",
  ".node-gyp/",
  ".zcompdump*",
];

/** Éléments du home à copier (chemins relatifs), sans les dossiers des outils IA ni les éléments absents. */
export async function homeItems(
  include: readonly string[],
  home: string,
  profiles: readonly AIHomePaths[],
): Promise<string[]> {
  const managed = aiManaged(profiles);
  const items = include
    .map((item) => (item.startsWith("~/") ? item.slice(2) : item))
    .filter((item) => !managed.some((m) => item === m || item.startsWith(`${m}/`)));
  const present = await Promise.all(items.map((item) => fileExists(path.join(home, item))));
  return items.filter((_, i) => present[i]);
}
