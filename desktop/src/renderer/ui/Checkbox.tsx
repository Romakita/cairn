import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./Checkbox.module.css";
import { Icon } from "./Icon.tsx";
import { Tooltip } from "./Tooltip.tsx";

export interface CheckboxProps {
  checked: boolean | "mixed";
  onChange: (checked: boolean) => void;
  /** Libellé cliquable à droite de la case. */
  children?: ReactNode;
  /** Nom accessible quand la case n'a pas de libellé visible (colonne d'un tableau). */
  label?: string;
  disabledReason?: string;
}

/** Case à cocher de Cairn (remplace `.checkbox`) : noire cochée, bordée sinon, état mixte possible. */
export function Checkbox({ checked, onChange, children, label, disabledReason }: CheckboxProps) {
  const disabled = Boolean(disabledReason);
  return (
    <Tooltip content={disabledReason}>
      {/* biome-ignore lint/a11y/useSemanticElements: case maison, l'input natif est interdit hors du rendu. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-description={disabledReason}
        className={styles.root}
        onClick={() => !disabled && onChange(checked !== true)}
      >
        <span className={styles.box} data-state={checked === "mixed" ? "mixed" : checked ? "on" : "off"}>
          {checked === true && <Icon icon={Check} size={12} />}
          {checked === "mixed" && <Icon icon={Minus} size={12} />}
        </span>
        {children && <span className={styles.label}>{children}</span>}
      </button>
    </Tooltip>
  );
}
