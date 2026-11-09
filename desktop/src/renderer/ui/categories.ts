import { Code, Folder, GitBranch, Hammer, Inbox, Package, Smartphone, Trash2 } from "lucide-react";
import type { LucideIcon } from "./Icon.tsx";

/** Catégories de l'analyse, dans l'ordre des graphiques (même ordre que la 0.8.0). */
export type CategoryKey = "source" | "git" | "deps" | "build" | "ios" | "python" | "cache" | "trash";

export const CATEGORY_KEYS: readonly CategoryKey[] = [
  "source",
  "git",
  "deps",
  "build",
  "ios",
  "python",
  "cache",
  "trash",
];

/** Couleur (jeton) et icône de chaque catégorie ; les libellés viennent des traductions `category.<clé>.*`. */
export const CATEGORIES: Record<CategoryKey, { color: string; icon: LucideIcon }> = {
  source: { color: "var(--category-source)", icon: Folder },
  git: { color: "var(--category-git)", icon: GitBranch },
  deps: { color: "var(--category-deps)", icon: Package },
  build: { color: "var(--category-build)", icon: Hammer },
  ios: { color: "var(--category-ios)", icon: Smartphone },
  python: { color: "var(--category-python)", icon: Code },
  cache: { color: "var(--category-cache)", icon: Inbox },
  trash: { color: "var(--category-trash)", icon: Trash2 },
};
