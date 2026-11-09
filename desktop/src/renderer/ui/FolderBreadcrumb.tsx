import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import styles from "./FolderBreadcrumb.module.css";
import { Icon } from "./Icon.tsx";

export interface Crumb {
  label: string;
  /** Identifiant du niveau ; absent pour « … » (niveaux masqués, non cliquable). */
  id?: string;
}

export interface FolderBreadcrumbProps {
  items: readonly Crumb[];
  onSelect: (id: string) => void;
  /** Nom accessible du fil d'Ariane. */
  label: string;
}

/** Fil d'Ariane d'un navigateur de dossiers : éléments style onglet, chevrons, le dernier sélectionné. */
export function FolderBreadcrumb({ items, onSelect, label }: FolderBreadcrumbProps) {
  return (
    <nav aria-label={label} className={styles.root}>
      {items.map((item, i) => {
        const current = i === items.length - 1;
        return (
          <Fragment key={item.id ?? `gap-${i}`}>
            {i > 0 && (
              <span className={styles.chevron} aria-hidden="true">
                <Icon icon={ChevronRight} size={11} />
              </span>
            )}
            {item.id === undefined ? (
              <span className={styles.gap}>{item.label}</span>
            ) : (
              <button
                type="button"
                className={styles.crumb}
                aria-current={current ? "location" : undefined}
                onClick={() => item.id !== undefined && onSelect(item.id)}
              >
                {item.label}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
