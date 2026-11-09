import { cx } from "./cx.ts";
import styles from "./Toggle.module.css";
import { Tooltip } from "./Tooltip.tsx";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Nom accessible (le titre de la ligne). Ou `labelledBy`. */
  label?: string;
  labelledBy?: string;
  disabledReason?: string;
  size?: "small" | "regular";
}

/** Rendu de l'interrupteur, sans comportement (ligne cochable dont toute la surface bascule). */
export function ToggleTrack({ checked, size = "regular" }: { checked: boolean; size?: "small" | "regular" }) {
  return (
    <span
      className={cx(styles.track, size === "small" && styles.small)}
      data-on={checked || undefined}
      aria-hidden="true"
    >
      <span className={styles.knob} />
    </span>
  );
}

/** Interrupteur de Cairn (bleu quand actif) : Espace ou Entrée le bascule. */
export function Toggle({ checked, onChange, label, labelledBy, disabledReason, size = "regular" }: ToggleProps) {
  const disabled = Boolean(disabledReason);
  return (
    <Tooltip content={disabledReason}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-disabled={disabled || undefined}
        aria-description={disabledReason}
        className={styles.button}
        onClick={() => !disabled && onChange(!checked)}
      >
        <ToggleTrack checked={checked} size={size} />
      </button>
    </Tooltip>
  );
}
