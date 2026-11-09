// Placement des éléments flottants (infobulle, menus) et fermeture (clic dehors, Échap, perte de focus).
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type Side = "top" | "right" | "bottom" | "left";
export type Align = "start" | "center" | "end";

export interface FloatingPosition {
  top: number;
  left: number;
  side: Side;
}

const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
/** Marge minimale entre un flottant et le bord de la fenêtre. */
const VIEWPORT_MARGIN = 8;

/** Valeur en pixels d'un jeton de taille (`--size-menu-gap`…), ou `fallback` hors navigateur. */
export function tokenPx(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

/** Position fixe d'un panneau de taille `size` contre `anchor`, retournée si elle déborde, gardée dans la fenêtre. */
export function computePosition(
  anchor: DOMRect,
  size: { width: number; height: number },
  side: Side,
  align: Align,
  gap: number,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): FloatingPosition {
  const m = VIEWPORT_MARGIN;
  const fits = (s: Side): boolean => {
    if (s === "bottom") return anchor.bottom + gap + size.height <= viewport.height - m;
    if (s === "top") return anchor.top - gap - size.height >= m;
    if (s === "right") return anchor.right + gap + size.width <= viewport.width - m;
    return anchor.left - gap - size.width >= m;
  };
  const chosen = !fits(side) && fits(opposite[side]) ? opposite[side] : side;
  let top: number;
  let left: number;
  if (chosen === "top" || chosen === "bottom") {
    top = chosen === "bottom" ? anchor.bottom + gap : anchor.top - gap - size.height;
    if (align === "start") left = anchor.left;
    else if (align === "end") left = anchor.right - size.width;
    else left = anchor.left + anchor.width / 2 - size.width / 2;
  } else {
    left = chosen === "right" ? anchor.right + gap : anchor.left - gap - size.width;
    if (align === "start") top = anchor.top;
    else if (align === "end") top = anchor.bottom - size.height;
    else top = anchor.top + anchor.height / 2 - size.height / 2;
  }
  const clamp = (v: number, max: number) => Math.min(Math.max(v, m), Math.max(m, max));
  return {
    top: clamp(top, viewport.height - size.height - m),
    left: clamp(left, viewport.width - size.width - m),
    side: chosen,
  };
}

/**
 * Position d'un panneau flottant ouvert : recalculée à l'ouverture, au redimensionnement et au défilement.
 * `null` tant que le panneau n'est pas mesuré (à rendre invisible).
 */
export function useFloating(
  open: boolean,
  getAnchor: () => DOMRect | null,
  panel: RefObject<HTMLElement | null>,
  side: Side,
  align: Align,
  gap: number,
): FloatingPosition | null {
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const anchorRef = useRef(getAnchor);
  anchorRef.current = getAnchor;
  const update = useCallback(() => {
    const rect = anchorRef.current();
    const element = panel.current;
    if (!rect || !element) return;
    setPosition(computePosition(rect, { width: element.offsetWidth, height: element.offsetHeight }, side, align, gap));
  }, [panel, side, align, gap]);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, update]);
  return position;
}

/** Ferme un flottant ouvert sur un clic hors de `inside`, sur Échap ou quand la fenêtre perd le focus. */
export function useDismiss(open: boolean, onClose: () => void, inside: Array<RefObject<HTMLElement | null>>): void {
  const close = useRef(onClose);
  close.current = onClose;
  const refs = useRef(inside);
  refs.current = inside;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && refs.current.some((r) => r.current?.contains(target))) return;
      close.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close.current();
    };
    const onBlur = () => close.current();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);
}

/** Déplace l'index courant d'une liste au clavier (flèches, Début, Fin), avec bouclage ; `null` si touche ignorée. */
export function moveIndex(key: string, index: number, count: number, axis: "horizontal" | "vertical"): number | null {
  if (count === 0) return null;
  const next = axis === "horizontal" ? "ArrowRight" : "ArrowDown";
  const previous = axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
  if (key === next) return (index + 1 + count) % count;
  if (key === previous) return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
