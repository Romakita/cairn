import { Check } from "lucide-react";
import styles from "./ChoiceChip.module.css";
import { Icon } from "./Icon.tsx";
import { Tooltip } from "./Tooltip.tsx";

export interface ChoiceChipProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Raison pour laquelle le choix ne peut pas changer : la puce est désactivée et l'infobulle la montre. */
  disabledReason?: string;
}

/** Puce activable (catégories des outils IA) : noire cochée quand active, bordée sinon. */
export function ChoiceChip({ label, checked, onChange, disabledReason }: ChoiceChipProps) {
  const disabled = Boolean(disabledReason);
  return (
    <Tooltip content={disabledReason}>
      <button
        type="button"
        className={styles.chip}
        aria-pressed={checked}
        aria-disabled={disabled || undefined}
        aria-description={disabledReason}
        data-on={checked || undefined}
        onClick={() => !disabled && onChange(!checked)}
      >
        {checked && <Icon icon={Check} size={12} />}
        {label}
      </button>
    </Tooltip>
  );
}
