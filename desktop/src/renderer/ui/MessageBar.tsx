import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { Icon, type LucideIcon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import styles from "./MessageBar.module.css";

export type MessageLevel = "info" | "success" | "warning" | "error";

export interface MessageBarProps {
  children: string;
  onClose: () => void;
  /** Nom du bouton de fermeture (« Fermer »). */
  closeLabel: string;
  /** Niveau du message : icône et couleur de l'icône (information par défaut). */
  level?: MessageLevel;
}

const ICONS: Record<MessageLevel, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
};

/** Barre de message en bas du contenu : icône du niveau, texte sélectionnable, croix ; trait en haut. */
export function MessageBar({ children, onClose, closeLabel, level = "info" }: MessageBarProps) {
  return (
    <div className={styles.bar} role={level === "error" ? "alert" : "status"} data-level={level}>
      <span className={styles.icon}>
        <Icon icon={ICONS[level]} size={16} />
      </span>
      <span className={styles.text}>{children}</span>
      <IconButton icon={X} label={closeLabel} onClick={onClose} />
    </div>
  );
}
