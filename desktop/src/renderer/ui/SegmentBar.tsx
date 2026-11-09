import type { CSSProperties } from "react";
import styles from "./SegmentBar.module.css";

export interface Segment {
  key: string;
  value: number;
  /** Couleur (jeton). */
  color: string;
}

/** Barre empilée de 8 : une part par valeur, séparées de 2 px ; invisible si le total est nul. */
export function SegmentBar({ parts, label }: { parts: readonly Segment[]; label?: string }) {
  const total = parts.reduce((sum, p) => sum + Math.max(p.value, 0), 0);
  return (
    <div className={styles.track} data-empty={total > 0 ? undefined : true} role="img" aria-label={label}>
      {total > 0 &&
        parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.key}
              className={styles.part}
              style={{ "--grow": p.value / total, "--part-color": p.color } as CSSProperties}
            />
          ))}
    </div>
  );
}
