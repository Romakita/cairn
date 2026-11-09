import { ChevronRight } from "lucide-react";
import styles from "./FolderRow.module.css";
import { Icon, type LucideIcon } from "./Icon.tsx";
import { IconTile } from "./IconTile.tsx";
import { MiddleText } from "./MiddleText.tsx";

export interface FolderRowProps {
  name: string;
  icon: LucideIcon;
  onOpen: () => void;
}

/** Dossier d'un navigateur : tuile, nom, chevron ; 44 de haut, toute la ligne ouvre le dossier. */
export function FolderRow({ name, icon, onOpen }: FolderRowProps) {
  return (
    <button type="button" className={styles.row} onClick={onOpen}>
      <IconTile icon={icon} size={28} />
      <MiddleText text={name} className={styles.name} />
      <span className={styles.chevron}>
        <Icon icon={ChevronRight} size={14} />
      </span>
    </button>
  );
}
