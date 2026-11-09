// Outils communs aux onglets de l'écran Analyse : catégories, part régénérable, chemins.
import { t } from "../../../core/l10n.ts";
import type { Category, NodeView } from "../../../shared/contract.ts";
import { CATEGORIES, CATEGORY_KEYS } from "../../ui/categories.ts";

/** Catégories qu'on peut supprimer sans perte (même règle que `isRegenerable` du core). */
export const REGENERABLE: readonly Category[] = ["deps", "build", "ios", "python", "cache"];

export function categoryShort(c: Category): string {
  return t(`category.${c}.short`);
}

export function categoryLabel(c: Category): string {
  return t(`category.${c}.label`);
}

export function categoryColor(c: Category): string {
  return CATEGORIES[c].color;
}

/** Octets régénérables d'un nœud, d'après sa répartition par catégorie. */
export function regenerableBytes(n: NodeView): number {
  return CATEGORY_KEYS.reduce((sum, c, i) => sum + (REGENERABLE.includes(c) ? (n.breakdown[i] ?? 0) : 0), 0);
}

/** Dossier parent d'un chemin (« /a/b/c » → « /a/b »). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** Chemin relatif au dossier suivi qui le contient, sinon le chemin complet. */
export function relativeTo(path: string, roots: readonly string[]): string {
  const root = roots.find((r) => path.startsWith(`${r}/`));
  return root ? `${baseName(root)}/${path.slice(root.length + 1)}` : path;
}
