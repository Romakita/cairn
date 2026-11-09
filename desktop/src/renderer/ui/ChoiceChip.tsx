import { Check } from "lucide-react";
import styles from "./ChoiceChip.module.css";
import { Icon } from "./Icon.tsx";

export interface ChoiceChipProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Puce activable (catégories des outils IA) : noire cochée quand active, bordée sinon. */
export function ChoiceChip({ label, checked, onChange }: ChoiceChipProps) {
  return (
    <button
      type="button"
      className={styles.chip}
      aria-pressed={checked}
      data-on={checked || undefined}
      onClick={() => onChange(!checked)}
    >
      {checked && <Icon icon={Check} size={12} />}
      {label}
    </button>
  );
}
