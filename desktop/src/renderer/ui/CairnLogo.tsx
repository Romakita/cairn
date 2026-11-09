import styles from "./CairnLogo.module.css";

/** Pierres du logo : centre vertical, largeur et hauteur, en fraction de la taille (géométrie de la 0.8.0). */
const STONES: ReadonlyArray<readonly [number, number, number]> = [
  [0.77, 0.62, 0.22],
  [0.53, 0.45, 0.19],
  [0.3, 0.27, 0.16],
];

export interface CairnLogoProps {
  size?: number;
  /** Pastille noire (barre du haut) : logo blanc à 60 % de la pastille. */
  badge?: boolean;
  /** Nom accessible ; sans lui le logo est décoratif. */
  label?: string;
}

/** Logo de Cairn : trois pierres empilées en trait, teintées comme le texte. */
export function CairnLogo({ size = 22, badge = false, label }: CairnLogoProps) {
  const inner = badge ? Math.round(size * 0.6) : size;
  const stroke = Math.max(1.2, inner / 14);
  const svg = (
    <svg
      width={inner}
      height={inner}
      viewBox={`0 0 ${inner} ${inner}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      aria-hidden="true"
      className={styles.svg}
    >
      {STONES.map(([cy, rw, rh]) => (
        <ellipse key={cy} cx={inner / 2} cy={inner * cy} rx={(inner * rw) / 2} ry={(inner * rh) / 2} />
      ))}
    </svg>
  );
  const className = badge ? styles.badge : styles.plain;
  const style = badge ? { width: size, height: size } : undefined;
  if (!label) {
    return (
      <span className={className} style={style} aria-hidden="true">
        {svg}
      </span>
    );
  }
  return (
    <span className={className} style={style} role="img" aria-label={label}>
      {svg}
    </span>
  );
}
