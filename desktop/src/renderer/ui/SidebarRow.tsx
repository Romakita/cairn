import type { CSSProperties } from "react";
import { cx } from "./cx.ts";
import { Icon, type LucideIcon } from "./Icon.tsx";
import { MiddleText } from "./MiddleText.tsx";
import { type MenuEntry, useContextMenu } from "./PopupMenu.tsx";
import styles from "./SidebarRow.module.css";
import { Spinner } from "./Spinner.tsx";

export interface SidebarRowProps {
  label: string;
  icon?: LucideIcon;
  /** Pastille de couleur (`var(--status-ok)`…), à la place de l'icône. */
  dot?: string;
  /** Information à droite (taille, état), chiffres tabulaires. */
  meta?: string;
  selected?: boolean;
  /** Tâche en cours sur l'élément : anneau et pourcentage si `fraction` est connue, sinon roue. */
  busy?: boolean;
  fraction?: number;
  /** Texte de l'avancement (« 42 % ») ; calculé si absent. */
  fractionLabel?: string;
  onClick?: () => void;
  /** Menu de la ligne, ouvert au clic droit (menu de Cairn, jamais natif). */
  menu?: readonly MenuEntry[];
  menuLabel?: string;
}

/** Anneau d'avancement de 13 px (trait 2,5). */
export function ProgressRing({
  fraction,
  size = 13,
  stroke = 2.5,
}: {
  fraction: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.min(Math.max(fraction, 0), 1);
  return (
    <svg className={styles.ring} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className={styles.ringTrack} cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <circle
        className={styles.ringValue}
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${c * f} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function percent(fraction: number): string {
  const locale = typeof document === "undefined" ? undefined : document.documentElement.lang || undefined;
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(fraction);
}

/** Ligne de la barre latérale : pastille ou icône, titre tronqué au milieu, méta à droite. */
export function SidebarRow({
  label,
  icon,
  dot,
  meta,
  selected = false,
  busy = false,
  fraction,
  fractionLabel,
  onClick,
  menu,
  menuLabel,
}: SidebarRowProps) {
  const context = useContextMenu(menu, menuLabel);
  const content = (
    <>
      {dot && <span className={styles.dot} style={{ "--dot": dot } as CSSProperties} />}
      {icon && <Icon icon={icon} size={16} />}
      <MiddleText text={label} className={styles.title} />
      <span className={styles.trailing}>
        {busy && fraction !== undefined && (
          <>
            <span className={styles.meta}>{fractionLabel ?? percent(fraction)}</span>
            <ProgressRing fraction={fraction} />
          </>
        )}
        {busy && fraction === undefined && <Spinner size="mini" />}
        {!busy && meta && <span className={styles.meta}>{meta}</span>}
      </span>
    </>
  );
  if (onClick) {
    return (
      <>
        <button
          type="button"
          className={cx(styles.row, styles.clickable)}
          aria-current={selected ? "true" : undefined}
          aria-busy={busy || undefined}
          data-selected={selected || undefined}
          onClick={onClick}
          onContextMenu={context.onContextMenu}
        >
          {content}
        </button>
        {context.menu}
      </>
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clic droit seulement, pour le menu de la ligne.
    <div
      className={styles.row}
      data-selected={selected || undefined}
      aria-busy={busy || undefined}
      onContextMenu={context.onContextMenu}
    >
      {content}
      {context.menu}
    </div>
  );
}
