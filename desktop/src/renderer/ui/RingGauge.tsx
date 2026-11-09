import type { CSSProperties, ReactNode } from "react";
import styles from "./RingGauge.module.css";

export interface RingGaugeProps {
  /** Remplissage entre 0 et 1. */
  value: number;
  /** Diamètre (118 dans la barre des menus). */
  size?: number;
  /** Épaisseur du trait. */
  stroke?: number;
  /** Couleur du remplissage (jeton) ; accent par défaut. */
  color?: string;
  /** Nom accessible de la jauge. */
  label: string;
  /** Contenu centré (chiffre, légende). */
  children?: ReactNode;
}

/** Jauge circulaire : piste grise, arc coloré depuis le haut, contenu au centre. */
export function RingGauge({ value, size = 118, stroke = 12, color, label, children }: RingGaugeProps) {
  const v = Math.min(Math.max(value, 0), 1);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const style = { width: size, height: size, ...(color ? { "--ring-color": color } : {}) } as CSSProperties;
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> natif n'est pas stylable de façon fiable.
    <div
      className={styles.gauge}
      style={style}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className={styles.svg}>
        <circle className={styles.track} cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className={styles.value}
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children && <div className={styles.center}>{children}</div>}
    </div>
  );
}
