import { Ellipsis } from "lucide-react";
import { Icon } from "./Icon.tsx";
import { MenuButton, type MenuEntry } from "./PopupMenu.tsx";

export interface MoreButtonProps {
  entries: readonly MenuEntry[] | (() => readonly MenuEntry[]);
  /** Nom accessible et infobulle (« Plus d'actions »). */
  label: string;
  align?: "start" | "end";
  disabledReason?: string;
}

/** Bouton « … » d'un en-tête de détail ou d'une ligne : ouvre le menu de Cairn, aligné sur son bord droit. */
export function MoreButton({ entries, label, align = "end", disabledReason }: MoreButtonProps) {
  return (
    <MenuButton
      entries={entries}
      label={label}
      tooltip={label}
      variant="more"
      align={align}
      disabledReason={disabledReason}
    >
      <Icon icon={Ellipsis} size={16} />
    </MenuButton>
  );
}
