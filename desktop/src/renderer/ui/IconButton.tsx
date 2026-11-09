import type { MouseEvent } from "react";
import type { Side } from "./floating.ts";
import { Icon, type LucideIcon } from "./Icon.tsx";
import styles from "./IconButton.module.css";
import { Tooltip } from "./Tooltip.tsx";

export interface IconButtonProps {
  icon: LucideIcon;
  /** Nom de l'action : nom accessible et infobulle. */
  label: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Action impossible : bouton désactivé, raison dans l'infobulle. */
  disabledReason?: string;
  tooltipSide?: Side;
}

/** Bouton icône discret (corbeille des listes de Codex) : 16 dans 28, fond gris au survol. */
export function IconButton({ icon, label, onClick, disabledReason, tooltipSide = "top" }: IconButtonProps) {
  const disabled = Boolean(disabledReason);
  return (
    <Tooltip content={disabledReason ?? label} side={tooltipSide}>
      <button
        type="button"
        className={styles.button}
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-description={disabledReason}
        onClick={(event) => {
          if (!disabled) onClick?.(event);
        }}
      >
        <Icon icon={icon} size={16} />
      </button>
    </Tooltip>
  );
}
