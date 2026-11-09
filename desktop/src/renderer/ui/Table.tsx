import { ChevronDown, ChevronUp } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useRef } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";
import { MoreButton } from "./MoreButton.tsx";
import { type MenuEntry, useContextMenu } from "./PopupMenu.tsx";
import styles from "./Table.module.css";

export interface TableColumn<Row> {
  id: string;
  header: string;
  /** Largeur CSS de la colonne (`minmax(0, 1fr)` par défaut, `96px`…). */
  width?: string;
  align?: "start" | "end";
  sortable?: boolean;
  render: (row: Row) => ReactNode;
}

export interface TableSort {
  column: string;
  direction: "ascending" | "descending";
}

export interface TableProps<Row> {
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Nom accessible du tableau. */
  label: string;
  sort?: TableSort;
  onSortChange?: (sort: TableSort) => void;
  selected?: string | null;
  onSelect?: (key: string) => void;
  /** Activation d'une ligne (double-clic, Entrée) : ouvrir le dossier… */
  onActivate?: (key: string) => void;
  /** Menu de chaque ligne : bouton « … » en fin de ligne et clic droit (jamais de menu natif). */
  rowMenu?: (row: Row) => readonly MenuEntry[];
  rowMenuLabel?: string;
  /** Texte quand il n'y a aucune ligne. */
  empty?: string;
}

interface RowProps<Row> {
  row: Row;
  columns: ReadonlyArray<TableColumn<Row>>;
  selected: boolean;
  selectable: boolean;
  menu?: readonly MenuEntry[];
  menuLabel?: string;
  onSelect?: () => void;
  onActivate?: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => void;
  rowRef: (el: HTMLTableRowElement | null) => void;
  focusable: boolean;
}

function TableRow<Row>({
  row,
  columns,
  selected,
  selectable,
  menu,
  menuLabel,
  onSelect,
  onActivate,
  onKeyDown,
  rowRef,
  focusable,
}: RowProps<Row>) {
  const context = useContextMenu(menu, menuLabel);
  return (
    <tr
      ref={rowRef}
      tabIndex={focusable ? 0 : -1}
      aria-selected={selectable ? selected : undefined}
      className={styles.row}
      data-selected={selected || undefined}
      onClick={onSelect}
      onDoubleClick={onActivate}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        onSelect?.();
        context.onContextMenu(event);
      }}
    >
      {columns.map((c) => (
        <td key={c.id} className={cx(styles.cell, c.align === "end" && styles.end)}>
          {c.render(row)}
        </td>
      ))}
      {menu !== undefined && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: le bouton « … » gère lui-même le clavier.
        <td className={styles.menuCell} onClick={(event) => event.stopPropagation()}>
          {menu.length > 0 && <MoreButton entries={menu} label={menuLabel ?? ""} />}
          {context.menu}
        </td>
      )}
    </tr>
  );
}

/**
 * Tableau de Cairn (remplace `Table` natif) : en-têtes triables, sélection, survol, menu « … » par ligne et clic
 * droit ; ↑/↓ pour changer de ligne, Entrée pour l'activer.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  label,
  sort,
  onSortChange,
  selected = null,
  onSelect,
  onActivate,
  rowMenu,
  rowMenuLabel,
  empty,
}: TableProps<Row>) {
  const refs = useRef<Array<HTMLTableRowElement | null>>([]);
  const template = [...columns.map((c) => c.width ?? "minmax(0, 1fr)"), ...(rowMenu ? ["40px"] : [])].join(" ");
  const keys = rows.map(rowKey);
  const selectedIndex = selected === null ? -1 : keys.indexOf(selected);
  return (
    <table className={styles.table} aria-label={label} style={{ "--columns": template } as CSSProperties}>
      <thead className={styles.head}>
        <tr className={styles.headerRow}>
          {columns.map((c) => {
            const active = sort?.column === c.id;
            return (
              <th
                key={c.id}
                scope="col"
                aria-sort={active ? sort?.direction : c.sortable ? "none" : undefined}
                className={cx(styles.header, c.align === "end" && styles.end)}
              >
                {c.sortable && onSortChange ? (
                  <button
                    type="button"
                    className={styles.sort}
                    onClick={() =>
                      onSortChange({
                        column: c.id,
                        direction: active && sort?.direction === "descending" ? "ascending" : "descending",
                      })
                    }
                  >
                    {c.header}
                    {active && <Icon icon={sort?.direction === "ascending" ? ChevronUp : ChevronDown} size={12} />}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            );
          })}
          {rowMenu && <th scope="col" className={styles.header} aria-label={rowMenuLabel} />}
        </tr>
      </thead>
      <tbody className={styles.body}>
        {rows.length === 0 && empty && (
          <tr>
            <td className={styles.empty}>{empty}</td>
          </tr>
        )}
        {rows.map((row, i) => {
          const key = keys[i]!;
          return (
            <TableRow
              key={key}
              row={row}
              columns={columns}
              selected={key === selected}
              selectable={Boolean(onSelect)}
              focusable={selectedIndex === -1 ? i === 0 : i === selectedIndex}
              menu={rowMenu ? rowMenu(row) : undefined}
              menuLabel={rowMenuLabel}
              onSelect={onSelect ? () => onSelect(key) : undefined}
              onActivate={onActivate ? () => onActivate(key) : undefined}
              rowRef={(el) => {
                refs.current[i] = el;
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter") {
                  onActivate?.(key);
                  return;
                }
                const next =
                  event.key === "ArrowDown"
                    ? Math.min(i + 1, rows.length - 1)
                    : event.key === "ArrowUp"
                      ? Math.max(i - 1, 0)
                      : null;
                if (next === null) return;
                event.preventDefault();
                onSelect?.(keys[next]!);
                refs.current[next]?.focus();
              }}
            />
          );
        })}
      </tbody>
    </table>
  );
}
