import type { CSSProperties } from "react";
import styles from "./ProgressBar.module.css";

export interface ProgressBarProps {
  /** Avancement entre 0 et 1 ; absent = indéterminé (bande qui défile). */
  value?: number;
  /** Nom accessible (« Copie des fichiers »). */
  label: string;
}

/** Barre de progression de 6, accent, 200 ms ease-out (remplace la barre linéaire native). */
export function ProgressBar({ value, label }: ProgressBarProps) {
  const determinate = value !== undefined;
  const v = Math.min(Math.max(value ?? 0, 0), 1);
  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(v * 100) : undefined}
      data-indeterminate={determinate ? undefined : true}
      style={{ "--progress": `${v * 100}%` } as CSSProperties}
    >
      <span className={styles.bar} />
    </div>
  );
}
