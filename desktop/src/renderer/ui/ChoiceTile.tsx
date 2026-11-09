import { Check } from "lucide-react";
import styles from "./ChoiceTile.module.css";
import { Icon, type LucideIcon } from "./Icon.tsx";
import { IconTile } from "./IconTile.tsx";

export interface ChoiceTileProps {
  icon: LucideIcon;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

/** Tuile de choix exclusif (type de destination) : tuile d'icône, rond coché, titre et description. */
export function ChoiceTile({ icon, label, description, selected, onSelect }: ChoiceTileProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: tuile maison, l'input radio natif n'est pas stylable.
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={styles.tile}
      data-selected={selected || undefined}
      onClick={onSelect}
    >
      <span className={styles.head}>
        <IconTile icon={icon} size={32} />
        <span className={styles.mark} aria-hidden="true">
          {selected && <Icon icon={Check} size={11} />}
        </span>
      </span>
      <span className={styles.title}>{label}</span>
      <span className={styles.description}>{description}</span>
    </button>
  );
}
