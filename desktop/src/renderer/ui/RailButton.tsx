import { Icon, type LucideIcon } from "./Icon.tsx";
import styles from "./RailButton.module.css";
import { Tooltip } from "./Tooltip.tsx";

export interface RailButtonProps {
  icon: LucideIcon;
  /** Nom de la section : nom accessible et infobulle à droite. */
  label: string;
  selected?: boolean;
  onClick?: () => void;
}

/** Bouton carré du rail : 40×40, actif sur fond gris sans ombre, infobulle sombre à droite. */
export function RailButton({ icon, label, selected = false, onClick }: RailButtonProps) {
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        className={styles.button}
        aria-label={label}
        aria-current={selected ? "page" : undefined}
        onClick={onClick}
      >
        <Icon icon={icon} size={20} />
      </button>
    </Tooltip>
  );
}
