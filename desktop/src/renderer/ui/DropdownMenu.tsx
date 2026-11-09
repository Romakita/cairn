import { ChevronDown } from "lucide-react";
import styles from "./DropdownMenu.module.css";
import { Icon } from "./Icon.tsx";
import { MenuButton } from "./PopupMenu.tsx";

export interface DropdownOption<V extends string | number> {
  value: V;
  label: string;
}

export interface DropdownMenuProps<V extends string | number> {
  options: ReadonlyArray<DropdownOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Nom accessible de la liste (« Fréquence »). */
  label: string;
  disabledReason?: string;
}

/** Liste déroulante bordée (« Terminal ⌄ ») : ouvre le menu de Cairn avec une coche sur la valeur. */
export function DropdownMenu<V extends string | number>({
  options,
  value,
  onChange,
  label,
  disabledReason,
}: DropdownMenuProps<V>) {
  const current = options.find((o) => o.value === value);
  return (
    <MenuButton
      variant="dropdown"
      label={label}
      align="start"
      minWidth={160}
      disabledReason={disabledReason}
      buttonLabel={`${label}, ${current?.label ?? ""}`}
      entries={() =>
        options.map((o) => ({
          id: String(o.value),
          label: o.label,
          checked: o.value === value,
          onSelect: () => onChange(o.value),
        }))
      }
    >
      <span className={styles.value}>{current?.label}</span>
      <span className={styles.chevron}>
        <Icon icon={ChevronDown} size={13} />
      </span>
    </MenuButton>
  );
}
