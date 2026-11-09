import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton.tsx";
import styles from "./Sheet.module.css";

export interface SheetProps {
  open: boolean;
  /** Fermeture (Échap, croix, clic sur le fond) ; absente pendant une opération qui ne peut pas être interrompue. */
  onClose?: () => void;
  heading: string;
  description?: string;
  children?: ReactNode;
  /** Pied : actions alignées à droite (Annuler, puis l'action principale ou `danger`). */
  footer?: ReactNode;
  /** Largeur en pixels (640 par défaut ; 760 pour une destination, 520 pour une suppression git). */
  width?: number;
  closeLabel: string;
  /** `inline` : la feuille seule, sans fond ni piège du focus (galerie, captures). */
  presentation?: "modal" | "inline";
}

const FOCUSABLE = 'button:not([aria-disabled="true"]), input, [tabindex]:not([tabindex="-1"])';

/** Feuille modale de Cairn (remplace dialogues et alertes natifs) : fond assombri, en-tête, contenu, pied. */
export function Sheet({
  open,
  onClose,
  heading,
  description,
  children,
  footer,
  width,
  closeLabel,
  presentation = "modal",
}: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  const modal = presentation === "modal";
  useEffect(() => {
    if (!open || !modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("[autofocus]") ?? panel.current;
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && close.current) {
        event.preventDefault();
        close.current();
      }
      if (event.key === "Tab" && panel.current) {
        const focusables = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (focusables.length === 0) return;
        const firstEl = focusables[0]!;
        const lastEl = focusables[focusables.length - 1]!;
        if (event.shiftKey && document.activeElement === firstEl) {
          event.preventDefault();
          lastEl.focus();
        } else if (!event.shiftKey && document.activeElement === lastEl) {
          event.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, modal]);

  if (!open) return null;
  const sheet = (
    <div
      ref={panel}
      role="dialog"
      aria-modal={modal}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      tabIndex={-1}
      className={styles.sheet}
      style={width ? { width } : undefined}
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={titleId} className={styles.title}>
            {heading}
          </h2>
          {description && (
            <p id={descriptionId} className={styles.description}>
              {description}
            </p>
          )}
        </div>
        {onClose && <IconButton icon={X} label={closeLabel} onClick={onClose} />}
      </header>
      {children && <div className={styles.body}>{children}</div>}
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </div>
  );
  if (!modal) return sheet;
  return createPortal(
    <div className={styles.scrim} onPointerDown={(event) => event.target === event.currentTarget && onClose?.()}>
      {sheet}
    </div>,
    document.body,
  );
}
