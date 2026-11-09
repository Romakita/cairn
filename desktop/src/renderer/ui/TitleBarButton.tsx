import type { Ref } from "react";
import { Icon, type LucideIcon } from "./Icon.tsx";
import { Spinner } from "./Spinner.tsx";
import styles from "./TitleBarButton.module.css";
import { Tooltip } from "./Tooltip.tsx";

/** Ton du bouton : neutre, accent (mise à jour), ou état global (ok, attention, erreur). */
export type TitleBarTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface TitleBarButtonProps {
  /** Texte visible ; aussi le nom accessible sans `label`. */
  text: string;
  /** Nom accessible s'il diffère du texte (« État : tout va bien »). */
  label?: string;
  icon?: LucideIcon;
  /** Roue à la place de l'icône (sauvegarde en cours). */
  busy?: boolean;
  tone?: TitleBarTone;
  onClick: () => void;
  /** Infobulle (sous le bouton). */
  tooltip?: string;
  /** Le bouton ouvre un panneau : `aria-expanded` suit son ouverture. */
  expanded?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}

/**
 * Bouton compact de la barre du haut (état global, mise à jour) : pilule de 26 px teintée par son ton, hors de la
 * zone de déplacement de la fenêtre.
 */
export function TitleBarButton({
  text,
  label,
  icon,
  busy = false,
  tone = "neutral",
  onClick,
  tooltip,
  expanded,
  buttonRef,
}: TitleBarButtonProps) {
  return (
    <Tooltip content={tooltip} side="bottom">
      <button
        ref={buttonRef}
        type="button"
        className={styles.button}
        data-tone={tone}
        aria-label={label}
        aria-expanded={expanded}
        aria-haspopup={expanded === undefined ? undefined : "dialog"}
        aria-busy={busy || undefined}
        onClick={onClick}
      >
        {busy ? <Spinner size="mini" inherit /> : icon && <Icon icon={icon} size={14} />}
        <span className={styles.text}>{text}</span>
      </button>
    </Tooltip>
  );
}
