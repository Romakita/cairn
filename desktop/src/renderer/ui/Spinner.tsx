import styles from "./Spinner.module.css";

export type SpinnerSize = "mini" | "small" | "regular" | "large";

const SIZES: Record<SpinnerSize, number> = { mini: 11, small: 14, regular: 18, large: 28 };

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Texte annoncé (« Chargement… ») ; sans lui la roue est décorative. */
  label?: string;
  /** Prend la couleur du texte parent (roue dans un bouton). */
  inherit?: boolean;
}

/** Roue d'attente maison (remplace `ProgressView`) : arc qui tourne sur une piste, teinte du texte secondaire. */
export function Spinner({ size = "small", label, inherit = false }: SpinnerProps) {
  const px = SIZES[size];
  const stroke = px < 16 ? 1.75 : 2.25;
  const r = (px - stroke) / 2;
  const c = 2 * Math.PI * r;
  const svg = (
    <svg className={styles.svg} width={px} height={px} viewBox={`0 0 ${px} ${px}`} fill="none" aria-hidden="true">
      <circle className={styles.track} cx={px / 2} cy={px / 2} r={r} strokeWidth={stroke} />
      <circle
        className={styles.arc}
        cx={px / 2}
        cy={px / 2}
        r={r}
        strokeWidth={stroke}
        strokeDasharray={`${c * 0.28} ${c}`}
        strokeLinecap="round"
      />
    </svg>
  );
  if (!label) {
    return (
      <span className={styles.root} data-inherit={inherit || undefined} aria-hidden="true">
        {svg}
      </span>
    );
  }
  return (
    <span className={styles.root} data-inherit={inherit || undefined} role="status" aria-label={label}>
      {svg}
    </span>
  );
}
