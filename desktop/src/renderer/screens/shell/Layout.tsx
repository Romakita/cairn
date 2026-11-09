// Mise en page commune des écrans à barre latérale (accueil, réglages) : sidebar de 248 à gauche, page défilante.
import type { ReactNode } from "react";
import styles from "./Layout.module.css";

export function SplitView({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.split}>
      {sidebar}
      <div className={styles.main}>{children}</div>
    </div>
  );
}

/** Barre latérale : titre de la section, puis groupes (`SidebarHeader` + `SidebarRow`). */
export function Sidebar({ heading, label, children }: { heading: string; label: string; children: ReactNode }) {
  return (
    <nav className={styles.sidebar} aria-label={label}>
      <h2 className={styles.sidebarTitle}>{heading}</h2>
      {children}
    </nav>
  );
}

/** Page défilante, centrée (largeur max), avec un titre facultatif et des actions à droite. */
export function Page({
  heading,
  actions,
  width = 760,
  children,
  footer,
}: {
  heading?: string;
  actions?: ReactNode;
  width?: number;
  children: ReactNode;
  /** Zone collée en bas, hors du défilement (problème prioritaire). */
  footer?: ReactNode;
}) {
  return (
    <div className={styles.pageFrame}>
      <div className={styles.scroll}>
        <div className={styles.page} style={{ maxWidth: width }}>
          {(heading || actions) && (
            <header className={styles.pageHeader}>
              {heading && <h1 className={styles.pageTitle}>{heading}</h1>}
              {actions && <div className={styles.pageActions}>{actions}</div>}
            </header>
          )}
          {children}
        </div>
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}

/** Section de page : titre de section au-dessus de son contenu (carte). */
export function Section({ heading, aside, children }: { heading: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={heading}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{heading}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
