import type { CSSProperties } from "react";
import styles from "./FillBar.module.css";

export interface FillBarProps {
  /** Remplissage entre 0 et 1. */
  value: number;
  /** Couleur du remplissage (jeton : `var(--tone-danger-fg)`…) ; accent par défaut. */
  color?: string;
  /** Nom accessible de la jauge (« Espace utilisé »). */
  label?: string;
}

/** Jauge horizontale de 8 : piste grise, remplissage d'au moins 4 px. */
export function FillBar({ value, color, label }: FillBarProps) {
  const v = Math.min(Math.max(value, 0), 1);
  const style = { "--fill": `${v * 100}%`, ...(color ? { "--fill-color": color } : {}) } as CSSProperties;
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> natif n'est pas stylable de façon fiable.
    <div
      className={styles.track}
      style={style}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <span className={styles.fill} />
    </div>
  );
}
