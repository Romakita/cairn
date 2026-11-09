import styles from "./RowDivider.module.css";

/** Séparateur entre deux lignes d'une carte, en retrait de 16 de chaque côté. */
export function RowDivider({ inset = true }: { inset?: boolean }) {
  return <hr className={styles.divider} data-inset={inset || undefined} />;
}
