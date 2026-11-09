import { Info, X } from "lucide-react";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import styles from "./MessageBar.module.css";

export interface MessageBarProps {
  children: string;
  onClose: () => void;
  /** Nom du bouton de fermeture (« Fermer »). */
  closeLabel: string;
}

/** Barre de message en bas du contenu : icône d'information, texte sélectionnable, croix ; trait en haut. */
export function MessageBar({ children, onClose, closeLabel }: MessageBarProps) {
  return (
    <div className={styles.bar} role="status">
      <span className={styles.icon}>
        <Icon icon={Info} size={16} />
      </span>
      <span className={styles.text}>{children}</span>
      <IconButton icon={X} label={closeLabel} onClick={onClose} />
    </div>
  );
}
