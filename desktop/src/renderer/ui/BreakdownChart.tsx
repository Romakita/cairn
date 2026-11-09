import type { CSSProperties } from "react";
import styles from "./BreakdownChart.module.css";

export interface BreakdownItem {
  key: string;
  label: string;
  value: number;
  /** Valeur formatée (« 31,6 Go »). */
  valueLabel: string;
  color: string;
}

export interface BreakdownChartProps {
  items: readonly BreakdownItem[];
  /** Total au centre (« 86 Go ») et ligne en dessous (« 412 380 fichiers »). */
  total: string;
  caption?: string;
  /** Nom accessible du graphique. */
  label: string;
}

const SIZE = 170;
const OUTER = SIZE / 2;
const INNER = OUTER * 0.6;
/** Écart entre deux secteurs, en degrés. */
const INSET = 1;

function point(radius: number, degrees: number): string {
  const a = ((degrees - 90) * Math.PI) / 180;
  return `${(OUTER + radius * Math.cos(a)).toFixed(3)} ${(OUTER + radius * Math.sin(a)).toFixed(3)}`;
}

function sector(start: number, end: number): string {
  const s = start + INSET / 2;
  const e = Math.max(s + 0.01, end - INSET / 2);
  const large = e - s > 180 ? 1 : 0;
  return [
    `M ${point(OUTER, s)}`,
    `A ${OUTER} ${OUTER} 0 ${large} 1 ${point(OUTER, e)}`,
    `L ${point(INNER, e)}`,
    `A ${INNER} ${INNER} 0 ${large} 0 ${point(INNER, s)}`,
    "Z",
  ].join(" ");
}

function percent(value: number, total: number): string {
  const locale = typeof document === "undefined" ? undefined : document.documentElement.lang || undefined;
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    value / Math.max(total, 1),
  );
}

/** Anneau de répartition par catégorie (rayon intérieur 60 %), total au centre, légende détaillée. */
export function BreakdownChart({ items, total, caption, label }: BreakdownChartProps) {
  const visible = items.filter((i) => i.value > 0);
  const sum = visible.reduce((s, i) => s + i.value, 0);
  let angle = 0;
  return (
    <figure className={styles.root} aria-label={label}>
      <div className={styles.ring}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          {visible.length === 1 ? (
            <circle
              cx={OUTER}
              cy={OUTER}
              r={(OUTER + INNER) / 2}
              fill="none"
              strokeWidth={OUTER - INNER}
              style={{ "--part-color": visible[0]!.color } as CSSProperties}
              className={styles.circle}
            />
          ) : (
            visible.map((item) => {
              const start = angle;
              angle += (item.value / sum) * 360;
              return (
                <path
                  key={item.key}
                  d={sector(start, angle)}
                  className={styles.sector}
                  style={{ "--part-color": item.color } as CSSProperties}
                />
              );
            })
          )}
        </svg>
        <div className={styles.center}>
          <span className={styles.total}>{total}</span>
          {caption && <span className={styles.caption}>{caption}</span>}
        </div>
      </div>
      <ul className={styles.legend}>
        {visible.map((item) => (
          <li key={item.key} className={styles.row}>
            <span className={styles.dot} style={{ "--part-color": item.color } as CSSProperties} />
            <span className={styles.name}>{item.label}</span>
            <span className={styles.value}>{item.valueLabel}</span>
            <span className={styles.percent}>{percent(item.value, sum)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
