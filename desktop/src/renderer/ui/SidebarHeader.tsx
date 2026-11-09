import styles from "./SidebarHeader.module.css";

/** Titre d'un groupe de la barre latérale (12 medium, gris). */
export function SidebarHeader({ label }: { label: string }) {
  return <h3 className={styles.header}>{label}</h3>;
}
