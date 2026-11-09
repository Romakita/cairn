import styles from "./MiddleText.module.css";

/** Nombre de caractères gardés en fin de texte quand il est tronqué au milieu. */
const TAIL = 14;

/** Texte sur une ligne, tronqué au milieu (chemins, noms longs) : le début se coupe, la fin reste visible. */
export function MiddleText({ text, className }: { text: string; className?: string }) {
  const tail = text.length > TAIL * 2 ? text.slice(-TAIL) : "";
  const head = tail ? text.slice(0, -TAIL) : text;
  return (
    <span className={`${styles.root} ${className ?? ""}`}>
      <span className={styles.head}>{head}</span>
      {tail && <span className={styles.tail}>{tail}</span>}
    </span>
  );
}
