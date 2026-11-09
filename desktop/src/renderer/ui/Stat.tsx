import styles from "./Stat.module.css";

export interface StatProps {
  label: string;
  value: string;
  detail?: string;
}

/** Chiffre clé : libellé, valeur (20 semibold, chiffres tabulaires), détail. */
export function Stat({ label, value, detail }: StatProps) {
  return (
    <div className={styles.stat}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
    </div>
  );
}
