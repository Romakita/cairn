import type { CSSProperties } from "react";
import styles from "./CategoryTag.module.css";
import { CATEGORIES, type CategoryKey } from "./categories.ts";
import { Icon } from "./Icon.tsx";

/** Étiquette d'une catégorie : icône et nom court sur sa couleur à 18 %. */
export function CategoryTag({ category, label }: { category: CategoryKey; label: string }) {
  const { color, icon } = CATEGORIES[category];
  return (
    <span className={styles.tag} data-tint="" style={{ "--tint": color } as CSSProperties}>
      <Icon icon={icon} size={11} />
      {label}
    </span>
  );
}
