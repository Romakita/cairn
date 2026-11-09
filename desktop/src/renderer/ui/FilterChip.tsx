import type { CSSProperties } from "react";
import styles from "./FilterChip.module.css";

export interface FilterChipProps {
  label: string;
  /** Total affiché (taille déjà formatée). */
  total?: string;
  /** Couleur de la catégorie (`var(--category-deps)`) ; accent pour « Tout ». */
  color: string;
  active: boolean;
  onClick: () => void;
}

/** Puce de filtre par catégorie : pastille, libellé, total ; teintée de la couleur quand le filtre est actif. */
export function FilterChip({ label, total, color, active, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      className={styles.chip}
      aria-pressed={active}
      data-tint=""
      data-active={active || undefined}
      style={{ "--tint": color } as CSSProperties}
      onClick={onClick}
    >
      <span className={styles.dot} />
      <span>{label}</span>
      {total && <span className={styles.total}>{total}</span>}
    </button>
  );
}
