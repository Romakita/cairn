import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

export interface PageHeaderProps {
  heading: string;
  /** Ligne sous le titre (date de la dernière analyse, nombre d'éléments…). */
  subtitle?: ReactNode;
  /** Actions à droite du titre : « … », secondaires, puis l'action principale. */
  actions?: ReactNode;
  /** Sous le titre : onglets de la page (`PillPicker`), filtres. */
  children?: ReactNode;
}

/** En-tête unique des pages (ui.md §4.9) : titre 26, sous-titre, actions à droite, onglets en dessous. */
export function PageHeader({ heading, subtitle, actions, children }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.top}>
        <div className={styles.heading}>
          <h1 className={styles.title}>{heading}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {children && <div className={styles.below}>{children}</div>}
    </header>
  );
}
