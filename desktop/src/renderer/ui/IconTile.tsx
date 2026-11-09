import type { CSSProperties } from "react";
import { Icon, type LucideIcon } from "./Icon.tsx";
import styles from "./IconTile.module.css";

export interface IconTileProps {
  icon: LucideIcon;
  /** Côté de la tuile (32 par défaut ; 30 ligne cochable, 28 dossier, 64 module). */
  size?: number;
  /** Couleur de module (`var(--module-storage)`…) : tuile teintée à 13 %, icône colorée. Accueil seulement. */
  tint?: string;
}

/** Icône dans une tuile carrée bordée (icônes de plugins de Codex) ; rayon 28 %, icône 52 % de la tuile. */
export function IconTile({ icon, size = 32, tint }: IconTileProps) {
  const style = { "--tile-size": `${size}px`, ...(tint ? { "--tint": tint } : {}) } as CSSProperties;
  return (
    <span className={styles.tile} style={style} data-tint={tint ? "" : undefined}>
      <Icon icon={icon} size={Math.round(size * 0.52)} />
    </span>
  );
}
