import type { ReactNode } from "react";
import styles from "./Card.module.css";

export interface CardProps {
  children: ReactNode;
  /** Sans marge intérieure (liste de `SettingsRow`, `CardTray`). */
  flush?: boolean;
  /** Marge intérieure en pixels (18 par défaut). */
  padding?: number;
  /** S'étire en hauteur (cartes d'une même rangée). */
  fill?: boolean;
  /** Nom de la région pour les lecteurs d'écran. */
  label?: string;
}

/** Carte : rayon 16, bordure légère, jamais d'ombre. */
export function Card({ children, flush = false, padding, fill = false, label }: CardProps) {
  return (
    <section
      className={styles.card}
      data-flush={flush || undefined}
      data-fill={fill || undefined}
      aria-label={label}
      style={padding !== undefined && !flush ? { padding } : undefined}
    >
      {children}
    </section>
  );
}
