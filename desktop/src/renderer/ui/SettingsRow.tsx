import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import type { LucideIcon } from "./Icon.tsx";
import { IconTile } from "./IconTile.tsx";
import { MiddleText } from "./MiddleText.tsx";
import styles from "./SettingsRow.module.css";

export interface SettingsRowProps {
  label: string;
  description?: string;
  icon?: LucideIcon;
  /** Titre en police fixe (chemin, nom de fichier). */
  mono?: boolean;
  /** Contrôle à droite (interrupteur, bouton, liste…). */
  children?: ReactNode;
}

/** Ligne de réglage : titre, description grise, contrôle à droite. Dans une `Card flush`, séparée par `RowDivider`. */
export function SettingsRow({ label, description, icon, mono = false, children }: SettingsRowProps) {
  return (
    <div className={styles.row}>
      {icon && <IconTile icon={icon} />}
      <div className={styles.text}>
        <MiddleText text={label} className={cx(styles.title, mono && styles.mono)} />
        {description && <span className={styles.description}>{description}</span>}
      </div>
      {children && <div className={styles.trailing}>{children}</div>}
    </div>
  );
}
