// Complétion des chemins relatifs à un dossier (le home) pour les champs de saisie (port de `PathCompletion`,
// PathCompletion.swift). Lecture seule.
import path from "node:path";
import { readdir, stat } from "./fs-promises.ts";

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const naturalCase = new Intl.Collator("en", { numeric: true, sensitivity: "case" });

/**
 * Tri du Finder (`localizedStandardCompare`) : sans tenir compte de la casse ni des accents, les nombres comparés
 * par leur valeur (`dossier2` avant `dossier10`). Les égalités sont départagées par la casse, puis les points de code.
 */
export function localizedStandardCompare(a: string, b: string): number {
  return natural.compare(a, b) || naturalCase.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export interface PathSuggestion {
  /** Chemin relatif complet proposé ; se termine par « / » pour un dossier. */
  path: string;
  isDirectory: boolean;
}

/**
 * Entrées de `base/<dossier saisi>` dont le nom commence par le dernier segment saisi (sans tenir compte de la casse).
 * Les fichiers cachés ne sont proposés que si le segment commence par « . » ou si on est dans un sous-dossier ; les
 * dossiers passent avant les fichiers, puis l'ordre alphabétique. `~/` est accepté ; un chemin absolu ou contenant
 * `..` ne propose rien.
 */
export async function pathSuggestions(
  input: string,
  base: string,
  options: { excluding?: ReadonlySet<string>; limit?: number } = {},
): Promise<PathSuggestion[]> {
  const excluding = options.excluding ?? new Set<string>();
  const limit = options.limit ?? 8;
  let text = input.replace(/^[ \t]+|[ \t]+$/g, "");
  if (text.startsWith("~/")) text = text.slice(2);
  if (text.startsWith("/") || text.includes("..")) return [];
  const slash = text.lastIndexOf("/");
  const dir = slash >= 0 ? text.slice(0, slash + 1) : "";
  const prefix = slash >= 0 ? text.slice(slash + 1) : text;
  const showHidden = prefix.startsWith(".") || dir !== "";
  const folder = dir === "" ? base : path.join(base, dir);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  const lowerPrefix = prefix.toLowerCase();
  const matches = names.filter(
    (name) =>
      (showHidden || !name.startsWith(".")) &&
      name !== ".DS_Store" &&
      name.toLowerCase().startsWith(lowerPrefix) &&
      name !== prefix,
  );
  const items: PathSuggestion[] = [];
  for (const name of matches) {
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(path.join(folder, name))).isDirectory();
    } catch {
      continue; // lien cassé : `fileExists` le refuse aussi
    }
    if (excluding.has(dir + name)) continue;
    items.push({ path: dir + name + (isDirectory ? "/" : ""), isDirectory });
  }
  return items
    .sort((a, b) =>
      a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : localizedStandardCompare(a.path, b.path),
    )
    .slice(0, limit);
}
