import type { CSSProperties } from "react";
import styles from "./BreakdownBar.module.css";

export interface BreakdownPart {
  key: string;
  value: number;
  /** Couleur (jeton de catégorie). */
  color: string;
}

export interface BreakdownBarProps {
  parts: readonly BreakdownPart[];
  /** Valeur qui correspond à toute la largeur (le plus gros élément de la liste) ; le total par défaut. */
  scale?: number;
  label?: string;
}

/** Barre empilée par catégorie (10 de haut, rayon 3), de largeur proportionnelle à `total / scale`. */
export function BreakdownBar({ parts, scale, label }: BreakdownBarProps) {
  const total = parts.reduce((s, p) => s + Math.max(p.value, 0), 0);
  const width = Math.min(1, total / Math.max(scale ?? total, 1));
  return (
    <div className={styles.track} role="img" aria-label={label}>
      <div className={styles.bar} style={{ "--width": `${width * 100}%` } as CSSProperties}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.key}
              className={styles.part}
              style={{ "--grow": p.value / Math.max(total, 1), "--part-color": p.color } as CSSProperties}
            />
          ))}
      </div>
    </div>
  );
}
