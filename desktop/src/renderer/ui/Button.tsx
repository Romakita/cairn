import type { MouseEvent, ReactNode } from "react";
import styles from "./Button.module.css";
import { cx } from "./cx.ts";
import { Icon, type LucideIcon } from "./Icon.tsx";
import { Spinner } from "./Spinner.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** primary : action principale (noire, une par zone) ; secondary : courante ; outline : action de carte ;
 *  danger : confirmation d'une suppression, dans une feuille seulement. */
export type ButtonVariant = "primary" | "secondary" | "outline" | "danger";

export interface ButtonProps {
  children: ReactNode;
  variant?: ButtonVariant;
  icon?: LucideIcon;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Raison pour laquelle l'action ne peut pas aboutir : le bouton est alors désactivé et l'infobulle la montre. */
  disabledReason?: string;
  /** Action en cours : roue à la place de l'icône, clics ignorés. */
  loading?: boolean;
  /** Aide affichée au survol quand le bouton est actif. */
  help?: string;
  type?: "button" | "submit";
  fullWidth?: boolean;
  autoFocus?: boolean;
}

/** Bouton en pilule de Cairn (`.pill*` de la 0.8.0). Jamais de bouton natif ailleurs. */
export function Button({
  children,
  variant = "secondary",
  icon,
  onClick,
  disabledReason,
  loading = false,
  help,
  type = "button",
  fullWidth = false,
  autoFocus,
}: ButtonProps) {
  const disabled = Boolean(disabledReason) || loading;
  return (
    <Tooltip content={disabledReason ?? help} block={fullWidth}>
      <button
        // biome-ignore lint/a11y/noAutofocus: choisi par l'écran appelant (feuille de confirmation).
        autoFocus={autoFocus}
        type={type}
        className={cx(styles.button, fullWidth && styles.full)}
        data-variant={variant}
        aria-disabled={disabled || undefined}
        aria-busy={loading || undefined}
        aria-description={disabledReason}
        onClick={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
      >
        {loading ? <Spinner size="small" inherit /> : icon && <Icon icon={icon} size={15} />}
        <span className={styles.label}>{children}</span>
      </button>
    </Tooltip>
  );
}
