// Onglet « Nettoyable » : dossiers régénérables, filtres par type, sélection (présélection venue d'une alerte),
// mise à la corbeille confirmée.
import { Copy, FolderSearch, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { Category, NodeView } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { CategoryTag } from "../../ui/CategoryTag.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { FilterChip } from "../../ui/FilterChip.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import type { MenuEntry } from "../../ui/PopupMenu.tsx";
import { Table, type TableSort } from "../../ui/Table.tsx";
import { TextField } from "../../ui/TextField.tsx";
import styles from "./Cleanable.module.css";
import { categoryColor, categoryShort, REGENERABLE, relativeTo } from "./common.ts";
import type { RemovalItem } from "./RemoveSheet.tsx";

export interface CleanableProps {
  nodes: readonly NodeView[];
  roots: readonly string[];
  selection: ReadonlySet<number>;
  onSelectionChange: (ids: Set<number>) => void;
  /** La sélection vient d'une alerte ou de la barre des menus. */
  preselected: boolean;
  removalBlocked: string | undefined;
  onRemove: (items: RemovalItem[]) => void;
}

const VALUES: Record<string, (n: NodeView) => number | string> = {
  type: (n) => categoryShort(n.category),
  path: (n) => n.path,
  files: (n) => n.fileCount,
  size: (n) => n.size,
};

export function Cleanable({
  nodes,
  roots,
  selection,
  onSelectionChange,
  preselected,
  removalBlocked,
  onRemove,
}: CleanableProps) {
  const api = useApi();
  const [filter, setFilter] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TableSort>({ column: "size", direction: "descending" });

  const totals = useMemo(() => {
    const m = new Map<Category, number>();
    for (const n of nodes) m.set(n.category, (m.get(n.category) ?? 0) + n.size);
    return m;
  }, [nodes]);
  const all = nodes.reduce((s, n) => s + n.size, 0);
  const q = query.trim().toLowerCase();
  const visible = nodes.filter(
    (n) => (filter === "all" || n.category === filter) && (q === "" || n.path.toLowerCase().includes(q)),
  );
  const value = VALUES[sort.column] ?? VALUES.size!;
  const rows = [...visible].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const d = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return sort.direction === "ascending" ? d : -d;
  });
  const chosen = nodes.filter((n) => selection.has(n.id));
  const chosenBytes = chosen.reduce((s, n) => s + n.size, 0);
  const visibleChosen = rows.filter((n) => selection.has(n.id)).length;

  const toggle = (id: number, on: boolean) => {
    const next = new Set(selection);
    if (on) next.add(id);
    else next.delete(id);
    onSelectionChange(next);
  };
  const setVisible = (on: boolean) => {
    const next = new Set(selection);
    for (const n of rows) {
      if (on) next.add(n.id);
      else next.delete(n.id);
    }
    onSelectionChange(next);
  };
  const removalOf = (list: readonly NodeView[]) => list.map((n) => ({ nodeId: n.id, path: n.path, size: n.size }));

  const menu = (n: NodeView): MenuEntry[] => [
    {
      id: "reveal",
      label: t("action.reveal"),
      icon: FolderSearch,
      onSelect: () => void api.showInFinder({ kind: "node", nodeId: n.id }),
    },
    { id: "copy", label: t("action.copy_path"), icon: Copy, onSelect: () => void api.copyText({ text: n.path }) },
    {
      id: "trash",
      label: t("action.trash_ellipsis"),
      icon: Trash2,
      destructive: true,
      disabledReason: removalBlocked,
      onSelect: () => onRemove(removalOf([n])),
    },
  ];

  const blocked = removalBlocked ?? (chosen.length === 0 ? t("storage.unavailable.none_selected") : undefined);

  return (
    <div className={styles.root}>
      {preselected && chosen.length > 0 && <Banner tone="info">{t("storage.clean.preselected")}</Banner>}
      <div className={styles.filters}>
        <fieldset className={styles.chips} aria-label={t("list.filter")}>
          <FilterChip
            label={t("list.all")}
            total={Fmt.bytes(all)}
            color="var(--color-accent)"
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {REGENERABLE.filter((c) => totals.has(c)).map((c) => (
            <FilterChip
              key={c}
              label={categoryShort(c)}
              total={Fmt.bytes(totals.get(c) ?? 0)}
              color={categoryColor(c)}
              active={filter === c}
              onClick={() => setFilter(filter === c ? "all" : c)}
            />
          ))}
        </fieldset>
        <div className={styles.search}>
          <TextField
            value={query}
            onChange={setQuery}
            icon={Search}
            type="search"
            placeholder={t("list.filter_path")}
            label={t("list.filter_path")}
          />
        </div>
      </div>
      <Table
        label={t("tab.cleanable")}
        rows={rows}
        rowKey={(n) => String(n.id)}
        sort={sort}
        onSortChange={setSort}
        onActivate={(key) => toggle(Number(key), !selection.has(Number(key)))}
        rowMenu={menu}
        rowMenuLabel={t("git.more")}
        empty={nodes.length === 0 ? t("storage.clean.empty") : t("storage.clean.no_match")}
        columns={[
          {
            id: "check",
            header: "",
            width: "28px",
            render: (n) => (
              <Checkbox
                checked={selection.has(n.id)}
                onChange={(on) => toggle(n.id, on)}
                label={t("storage.clean.select", n.path)}
              />
            ),
          },
          {
            id: "type",
            header: t("col.type"),
            sortable: true,
            width: "128px",
            render: (n) => <CategoryTag category={n.category} label={categoryShort(n.category)} />,
          },
          {
            id: "path",
            header: t("col.path"),
            sortable: true,
            render: (n) => <MiddleText text={relativeTo(n.path, roots)} className={styles.path} />,
          },
          {
            id: "files",
            header: t("col.files"),
            sortable: true,
            align: "end",
            width: "84px",
            render: (n) => <span className={styles.secondary}>{Fmt.count(n.fileCount)}</span>,
          },
          {
            id: "size",
            header: t("col.size"),
            sortable: true,
            align: "end",
            width: "84px",
            render: (n) => Fmt.bytes(n.size),
          },
        ]}
      />
      <footer className={styles.footer}>
        <div className={styles.selectButtons}>
          <Button
            onClick={() => setVisible(true)}
            disabledReason={
              rows.length === 0 || visibleChosen === rows.length ? t("storage.clean.all_selected") : undefined
            }
          >
            {t("action.select_all")}
          </Button>
          <Button
            onClick={() => setVisible(false)}
            disabledReason={visibleChosen === 0 ? t("storage.unavailable.none_selected") : undefined}
          >
            {t("action.select_none")}
          </Button>
        </div>
        <span className={styles.summary} aria-live="polite">
          {chosen.length > 0
            ? t("list.selected_total", Fmt.count(chosen.length), Fmt.bytes(chosenBytes))
            : t("list.folders_total", Fmt.count(nodes.length), Fmt.bytes(all))}
        </span>
        <Button variant="primary" icon={Trash2} disabledReason={blocked} onClick={() => onRemove(removalOf(chosen))}>
          {t("action.trash_ellipsis")}
        </Button>
      </footer>
    </div>
  );
}
