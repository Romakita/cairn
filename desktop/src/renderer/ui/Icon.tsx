import type { LucideIcon } from "lucide-react";
import styles from "./Icon.module.css";

export type { LucideIcon };

/** Épaisseur de trait commune à toutes les icônes (Lucide ramené à 1,6 comme la 0.8.0). */
export const ICON_STROKE = 1.6;

export interface IconProps {
  /** Icône Lucide (`import { House } from "lucide-react"`). */
  icon: LucideIcon;
  /** Boîte de l'icône en pixels (rail 20, ligne 16, bouton 15, bandeau 17). */
  size?: number;
  /** Texte pour les lecteurs d'écran ; sans lui l'icône est décorative. */
  label?: string;
}

/** Icône de Cairn : Lucide, trait 1,6, teinte du texte. */
export function Icon({ icon: Glyph, size = 16, label }: IconProps) {
  return (
    <Glyph
      className={styles.icon}
      size={size}
      strokeWidth={ICON_STROKE}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable={false}
    />
  );
}
