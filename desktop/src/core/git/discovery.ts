// Découverte des dépôts et dernière modification d'un dossier (port de `GitMaintenance.discover` et `lastModified`).
// Parcours asynchrone (`fs/promises`), sans suivre les liens symboliques, avec la classification du scanner :
// node_modules, build à côté d'un package.json, corbeille… ne sont pas parcourus (StorageWarningTests).
import path from "node:path";
import type { Dirent } from "../fs.ts";
import { lstat, readdir } from "../fs-promises.ts";
import { expandTilde } from "../paths.ts";
import type { Classify } from "./types.ts";

/** Dossiers système de volume, en plus des dossiers classés non-source par le scanner. */
export const SYSTEM_FOLDERS: ReadonlySet<string> = new Set([
  ".Spotlight-V100",
  ".fseventsd",
  ".DocumentRevisions-V100",
  ".TemporaryItems",
]);

/** Dossier où l'on ne cherche pas de dépôt. */
export async function skipsDiscovery(name: string, parentPath: string, classify: Classify): Promise<boolean> {
  return SYSTEM_FOLDERS.has(name) || (await classify(name, parentPath)) !== "source";
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // dossier illisible : ignoré, comme l'`errorHandler` de la 0.8.0
  }
}

/**
 * Dépôts : dossiers contenant un dossier `.git` (un fichier `.git`, celui d'un worktree lié, ne compte pas). On ne
 * descend pas dans `.git` ni dans un dossier non-source, mais on continue dans le reste du dépôt (sous-dépôts), comme
 * la 0.8.0. Résultat dédoublonné et trié.
 */
export async function discover(folders: readonly string[], classify: Classify): Promise<string[]> {
  const repos = new Set<string>();
  for (const folder of folders) {
    const stack = [expandTilde(folder)];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const children: string[] = [];
      for (const e of await entries(dir)) {
        if (!e.isDirectory()) continue; // fichiers et liens symboliques (Dirent ne suit pas les liens)
        if (e.name === ".git") {
          repos.add(dir);
        } else if (!(await skipsDiscovery(e.name, dir, classify))) {
          children.push(path.join(dir, e.name));
        }
      }
      // Pile : les enfants inversés pour parcourir dans l'ordre du dossier.
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
  }
  return [...repos].sort();
}

/**
 * Fichier le plus récemment modifié (mtime du fichier ou du lien), hors `.git` et dossiers non-source. Au plus
 * `limit` entrées parcourues (fichiers et dossiers), comme la 0.8.0.
 */
export async function lastModified(root: string, classify: Classify, limit = 200_000): Promise<Date | null> {
  let newest = 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0 && count <= limit) {
    const dir = stack.pop()!;
    const list = await entries(dir);
    const files: string[] = [];
    const children: string[] = [];
    for (const e of list) {
      count += 1;
      if (count > limit) break;
      if (e.isDirectory()) {
        if (e.name !== ".git" && (await classify(e.name, dir)) === "source") children.push(path.join(dir, e.name));
      } else {
        files.push(path.join(dir, e.name));
      }
    }
    const stats = await Promise.all(files.map((f) => lstat(f).catch(() => null)));
    for (const s of stats) if (s && s.mtimeMs > newest) newest = s.mtimeMs;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return newest > 0 ? new Date(newest) : null;
}
