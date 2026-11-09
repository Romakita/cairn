import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { type Align, type Side, tokenPx, useDismiss, useFloating } from "./floating.ts";
import styles from "./Popover.module.css";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Élément qui ouvre le panneau (un clic dessus ne le ferme pas : il bascule). */
  anchor: RefObject<HTMLElement | null>;
  /** Nom accessible du panneau. */
  label: string;
  /** Largeur en pixels (400 pour la mise à jour). */
  width?: number;
  side?: Side;
  align?: Align;
  children: ReactNode;
}

/**
 * Panneau flottant ancré à un bouton (popover de la mise à jour) : sous l'ancre, ombré, fermé par clic dehors, Échap
 * ou perte de focus de la fenêtre ; le focus revient à l'ancre.
 */
export function Popover({
  open,
  onClose,
  anchor,
  label,
  width,
  side = "bottom",
  align = "end",
  children,
}: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const position = useFloating(
    open,
    () => anchor.current?.getBoundingClientRect() ?? null,
    panel,
    side,
    align,
    tokenPx("--size-menu-gap", 6),
  );
  useDismiss(open, onClose, [panel, anchor]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const target = anchor.current;
    return () => target?.focus();
  }, [open, anchor]);
  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={styles.panel}
      style={{
        ...(width ? { width } : {}),
        ...(position ? { top: position.top, left: position.left } : { opacity: 0, top: 0, left: 0 }),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
