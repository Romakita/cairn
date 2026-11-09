import { Check } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx.ts";
import { type Align, moveIndex, tokenPx, useDismiss, useFloating } from "./floating.ts";
import { Icon, type LucideIcon } from "./Icon.tsx";
import styles from "./PopupMenu.module.css";
import { Tooltip } from "./Tooltip.tsx";

export interface MenuItem {
  kind?: "item";
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Valeur courante d'une liste déroulante (coche). */
  checked?: boolean;
  /** Action destructive : en rouge, placée en dernier après un séparateur. */
  destructive?: boolean;
  /** Action impossible : grisée, raison dans l'infobulle. */
  disabledReason?: string;
  onSelect: () => void;
}

export interface MenuSeparator {
  kind: "separator";
}

export type MenuEntry = MenuItem | MenuSeparator;

const isItem = (e: MenuEntry): e is MenuItem => e.kind !== "separator";

/**
 * Règles du menu de Cairn : les actions destructives vont en dernier, après un séparateur ; pas de séparateur
 * en tête, en fin ni en double.
 */
export function normalizeEntries(entries: readonly MenuEntry[]): MenuEntry[] {
  const regular = entries.filter((e) => !isItem(e) || !e.destructive);
  const destructive = entries.filter((e) => isItem(e) && e.destructive);
  const ordered: MenuEntry[] = destructive.length ? [...regular, { kind: "separator" }, ...destructive] : [...regular];
  const result: MenuEntry[] = [];
  for (const entry of ordered) {
    if (!isItem(entry) && (result.length === 0 || !isItem(result[result.length - 1]!))) continue;
    result.push(entry);
  }
  while (result.length && !isItem(result[result.length - 1]!)) result.pop();
  return result;
}

export interface PopupMenuProps {
  entries: readonly MenuEntry[];
  /** Appelé après le choix d'un élément, ou pour fermer (Tab). */
  onClose?: () => void;
  /** Largeur minimale (200, 160 pour une liste déroulante). */
  minWidth?: number;
  /** Donne le focus au premier élément actif (ouverture au clavier ou à la souris). */
  autoFocus?: boolean;
  /** Nom accessible du menu. */
  label?: string;
  id?: string;
}

/** Panneau du menu de Cairn : lignes icône + texte, séparateurs, destructif en rouge et en dernier. */
export function PopupMenu({ entries, onClose, minWidth, autoFocus = false, label, id }: PopupMenuProps) {
  const list = normalizeEntries(entries);
  const items = list.filter(isItem);
  const hasIcons = items.some((i) => i.icon || i.checked !== undefined);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      items.findIndex((i) => i.checked),
    ),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus initial seulement, à l'ouverture.
  useEffect(() => {
    if (autoFocus) refs.current[active]?.focus();
  }, [autoFocus]);

  const focusAt = (index: number) => {
    setActive(index);
    refs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      onClose?.();
      return;
    }
    const next = moveIndex(event.key, active, items.length, "vertical");
    if (next === null) return;
    event.preventDefault();
    focusAt(next);
  };

  let itemIndex = -1;
  return (
    <div
      id={id}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className={styles.panel}
      style={minWidth ? ({ "--menu-min": `${minWidth}px` } as CSSProperties) : undefined}
      onKeyDown={onKeyDown}
    >
      {list.map((entry, position) => {
        if (!isItem(entry)) {
          // biome-ignore lint/suspicious/noArrayIndexKey: un séparateur n'a pas d'identité propre.
          return <hr key={`sep-${position}`} className={styles.separator} />;
        }
        itemIndex += 1;
        const index = itemIndex;
        const disabled = Boolean(entry.disabledReason);
        const glyph = entry.checked ? Check : entry.icon;
        const row = (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: rôle menuitemradio quand l'élément porte une coche.
          <button
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={entry.checked === undefined ? undefined : entry.checked}
            aria-disabled={disabled || undefined}
            aria-description={entry.disabledReason}
            tabIndex={index === active ? 0 : -1}
            className={cx(styles.item, entry.destructive && styles.destructive)}
            onPointerMove={() => setActive(index)}
            onClick={() => {
              if (disabled) return;
              onClose?.();
              entry.onSelect();
            }}
          >
            {hasIcons && <span className={styles.glyph}>{glyph && <Icon icon={glyph} size={16} />}</span>}
            <span className={styles.label}>{entry.label}</span>
          </button>
        );
        return (
          <Tooltip key={entry.id} content={entry.disabledReason} side="right" block>
            {row}
          </Tooltip>
        );
      })}
    </div>
  );
}

interface FloatingMenuProps {
  entries: readonly MenuEntry[];
  getAnchor: () => DOMRect | null;
  align: Align;
  minWidth?: number;
  label?: string;
  id?: string;
  onClose: () => void;
  /** Éléments qui ne ferment pas le menu quand on clique dessus (le bouton qui l'ouvre). */
  inside?: Array<React.RefObject<HTMLElement | null>>;
}

/** Menu flottant : sous l'ancre (6 px), sinon au-dessus ; fermé par clic dehors, Échap ou perte de focus. */
function FloatingMenu({ entries, getAnchor, align, minWidth, label, id, onClose, inside = [] }: FloatingMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const position = useFloating(true, getAnchor, panel, "bottom", align, tokenPx("--size-menu-gap", 6));
  useDismiss(true, onClose, [panel, ...inside]);
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: ferme le menu quand le focus en sort (Tab, clic ailleurs).
    <div
      ref={panel}
      className={styles.floating}
      style={position ? { top: position.top, left: position.left } : { opacity: 0, top: 0, left: 0 }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !panel.current?.contains(next) && !inside.some((r) => r.current?.contains(next))) onClose();
      }}
    >
      <PopupMenu entries={entries} onClose={onClose} minWidth={minWidth} autoFocus label={label} id={id} />
    </div>,
    document.body,
  );
}

export type MenuButtonVariant = "more" | "dropdown" | "plain";

export interface MenuButtonProps {
  entries: readonly MenuEntry[] | (() => readonly MenuEntry[]);
  /** Nom accessible du bouton et du menu (« Plus d'actions »). */
  label: string;
  /** Contenu du bouton (icône « … », valeur et chevron…). */
  children: ReactNode;
  variant?: MenuButtonVariant;
  /** Bord du bouton sur lequel le menu s'aligne. */
  align?: Align;
  minWidth?: number;
  disabledReason?: string;
  /** Infobulle du bouton (le nom de l'action pour un bouton icône). */
  tooltip?: string;
  /** Nom accessible du bouton s'il diffère de `label` (liste déroulante : « Fréquence, Chaque semaine »). */
  buttonLabel?: string;
}

/** Bouton qui ouvre le menu de Cairn (tout menu « … » et toute liste déroulante). */
export function MenuButton({
  entries,
  label,
  children,
  variant = "plain",
  align = "end",
  minWidth,
  disabledReason,
  tooltip,
  buttonLabel,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  const disabled = Boolean(disabledReason);
  return (
    <>
      <Tooltip content={disabledReason ?? (open ? undefined : tooltip)}>
        <button
          ref={button}
          type="button"
          className={styles.trigger}
          data-variant={variant}
          data-open={open || undefined}
          aria-label={buttonLabel ?? label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-disabled={disabled || undefined}
          aria-description={disabledReason}
          onClick={() => !disabled && setOpen((o) => !o)}
          onKeyDown={(event) => {
            if (!disabled && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          {children}
        </button>
      </Tooltip>
      {open && (
        <FloatingMenu
          id={menuId}
          entries={typeof entries === "function" ? entries() : entries}
          getAnchor={() => button.current?.getBoundingClientRect() ?? null}
          align={align}
          minWidth={minWidth}
          label={label}
          onClose={close}
          inside={[button]}
        />
      )}
    </>
  );
}

/**
 * Menu contextuel de Cairn sur une ligne (clic droit, touche Menu) : jamais le menu natif.
 * `onContextMenu` va sur la ligne ; `menu` se rend n'importe où dans l'arbre (il est porté dans le body).
 */
export function useContextMenu(entries: readonly MenuEntry[] | null | undefined, label?: string) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = useCallback(
    (event: MouseEvent) => {
      if (!entries || entries.length === 0) return;
      event.preventDefault();
      const target = event.currentTarget.getBoundingClientRect();
      // Touche Menu : pas de coordonnées de souris, le menu s'ouvre sous la ligne.
      const keyboard = event.clientX === 0 && event.clientY === 0;
      setPoint(keyboard ? { x: target.left + 16, y: target.bottom } : { x: event.clientX, y: event.clientY });
    },
    [entries],
  );
  const menu =
    point && entries ? (
      <FloatingMenu
        entries={entries}
        getAnchor={() => new DOMRect(point.x, point.y, 0, 0)}
        align="start"
        label={label}
        onClose={() => setPoint(null)}
      />
    ) : null;
  return { onContextMenu, menu, open: point !== null };
}
