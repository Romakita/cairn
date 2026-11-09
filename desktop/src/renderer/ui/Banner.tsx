import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./Banner.module.css";
import { Icon, type LucideIcon } from "./Icon.tsx";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE_ICONS: Record<Tone, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

export interface BannerProps {
  children: ReactNode;
  tone?: Tone;
  /** Icône ; celle du ton par défaut. */
  icon?: LucideIcon;
  /** Action à droite (bouton `outline`). */
  action?: ReactNode;
}

/** Bandeau d'information ou d'alerte : icône, texte, action ; couleurs du ton. */
export function Banner({ children, tone = "warning", icon, action }: BannerProps) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      <Icon icon={icon ?? TONE_ICONS[tone]} size={17} />
      <div className={styles.text}>{children}</div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
