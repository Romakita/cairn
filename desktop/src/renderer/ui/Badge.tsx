import styles from "./Badge.module.css";
import type { Tone } from "./Banner.tsx";

/** Petite étiquette d'état en capsule, aux couleurs d'un ton. Casse : majuscule initiale, comme tous les badges. */
export function Badge({ children, tone = "neutral" }: { children: string; tone?: Tone }) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}
