import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx.ts";
import { type Side, tokenPx, useFloating } from "./floating.ts";
import styles from "./Tooltip.module.css";

/** Délai d'apparition au survol (jeton `--delay-tooltip`). */
const DELAY_MS = 350;

export interface TooltipProps {
  /** Texte de la bulle ; sans texte, l'enfant est rendu seul. */
  content?: ReactNode;
  /** Côté préféré (retourné s'il n'y a pas la place). Le rail utilise `right`. */
  side?: Side;
  /** Force l'affichage (galerie, captures). */
  open?: boolean;
  /** L'ancre prend toute la largeur (ligne, élément de menu). */
  block?: boolean;
  children: ReactNode;
}

/**
 * Infobulle de Cairn (une seule pour toute l'app) : bulle sombre après 350 ms de survol ou au focus clavier,
 * placée en haut (ou au côté demandé). Marche aussi sur un bouton désactivé : l'ancre enveloppe l'élément.
 */
export function Tooltip({ content, side = "top", open, block = false, children }: TooltipProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const id = useId();
  const visible = Boolean(content) && (open ?? shown);
  const position = useFloating(
    visible,
    () => (anchor.current?.firstElementChild ?? anchor.current)?.getBoundingClientRect() ?? null,
    bubble,
    side,
    "center",
    tokenPx("--size-tooltip-gap", 8),
  );
  const show = useCallback((delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(true), delay);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setShown(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!visible || open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && hide();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, open, hide]);

  // Toujours la même enveloppe, avec ou sans texte : l'enfant n'est pas recréé (il garde le focus) quand la raison
  // d'une désactivation apparaît ou disparaît.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: l'ancre ne fait qu'observer le survol de son enfant.
    <span
      ref={anchor}
      className={cx(styles.anchor, block && styles.block)}
      onPointerEnter={() => show(DELAY_MS)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(event) => event.target.matches(":focus-visible") && show(DELAY_MS)}
      onBlur={hide}
      data-tooltip-anchor={id}
    >
      {children}
      {visible &&
        createPortal(
          <div
            ref={bubble}
            id={id}
            role="tooltip"
            className={styles.bubble}
            data-side={position?.side ?? side}
            style={position ? { top: position.top, left: position.left } : { visibility: "hidden", top: 0, left: 0 }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
