import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";
import { Icon, type LucideIcon } from "./Icon.tsx";
import { Spinner } from "./Spinner.tsx";

export interface EmptyStateProps {
  /** Grande icône (39) ; ignorée quand `busy`. */
  icon?: LucideIcon;
  /** Opération en cours : grande roue à la place de l'icône. */
  busy?: boolean;
  heading: string;
  /** Texte d'explication, ou détail de l'opération (chemin courant…). */
  children?: ReactNode;
  /** Boutons sous le texte (action principale en dernier). */
  actions?: ReactNode;
}

/** État vide ou opération en cours d'une page (« Rien d'analysé », « Analyse de … ») : centré, sans carte. */
export function EmptyState({ icon, busy = false, heading, children, actions }: EmptyStateProps) {
  return (
    <div className={styles.root} aria-busy={busy || undefined}>
      <span className={styles.icon}>{busy ? <Spinner size="large" /> : icon && <Icon icon={icon} size={39} />}</span>
      <h2 className={styles.title}>{heading}</h2>
      {children && <div className={styles.text}>{children}</div>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
