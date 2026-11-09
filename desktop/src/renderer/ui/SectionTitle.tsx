import type { ReactNode } from "react";
import styles from "./SectionTitle.module.css";

/** Titre de section au-dessus d'une carte (15 medium) ; action optionnelle à droite. */
export function SectionTitle({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className={styles.root}>
      <h2 className={styles.title}>{label}</h2>
      {children}
    </div>
  );
}
