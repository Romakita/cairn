import type { ReactNode } from "react";
import styles from "./CardTray.module.css";

/** Plateau gris en bas d'une carte `flush`, pour ajouter un élément à la liste. */
export function CardTray({ children }: { children: ReactNode }) {
  return <div className={styles.tray}>{children}</div>;
}
