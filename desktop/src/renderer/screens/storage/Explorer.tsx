// Onglet « Explorateur » : arbre de l'analyse lu à la demande (`analysisChildren`), fil d'Ariane, menu par ligne.
import { ArrowUp, Copy, File, Folder, FolderGit2, FolderOpen, FolderSearch, HardDrive, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { FolderScanView, NodeView } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { BreakdownBar } from "../../ui/BreakdownBar.tsx";
import { CategoryTag } from "../../ui/CategoryTag.tsx";
import { CATEGORY_KEYS } from "../../ui/categories.ts";
import { type Crumb, FolderBreadcrumb } from "../../ui/FolderBreadcrumb.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import type { MenuEntry } from "../../ui/PopupMenu.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { Table, type TableSort } from "../../ui/Table.tsx";
import { categoryColor, categoryShort, regenerableBytes } from "./common.ts";
import styles from "./Explorer.module.css";
import type { RemovalItem } from "./RemoveSheet.tsx";

export interface ExplorerProps {
  folders: readonly FolderScanView[];
  /** Dossier suivi à ouvrir (lien depuis l'accueil). */
  initialFolder?: string;
  /** Change après une suppression : relire le dossier affiché. */
  reloadKey: number;
  removalBlocked: string | undefined;
  onRemove: (items: RemovalItem[]) => void;
}

const isOpenable = (n: NodeView) => n.isDirectory && n.childCount > 0;

export function Explorer({ folders, initialFolder, reloadKey, removalBlocked, onRemove }: ExplorerProps) {
  const api = useApi();
  const roots = folders.flatMap((f) => (f.root ? [f.root] : []));
  const single = roots.length === 1;
  const [trail, setTrail] = useState<NodeView[]>(() => {
    const start = roots.find((r) => r.path === initialFolder) ?? (single ? roots[0] : undefined);
    return start ? [start] : [];
  });
  const [children, setChildren] = useState<NodeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<TableSort>({ column: "size", direction: "descending" });
  const current = trail.at(-1) ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: relu quand le dossier change ou après une suppression.
  useEffect(() => {
    if (!current) {
      setChildren(null);
      return;
    }
    let live = true;
    setChildren(null);
    setError(null);
    api.analysisChildren({ nodeId: current.id }).then(
      (nodes) => live && setChildren(nodes),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api, current?.id, reloadKey]);

  const open = useCallback((n: NodeView) => {
    setTrail((tr) => [...tr, n]);
    setSelected(null);
  }, []);
  const up = useCallback(() => {
    setTrail((tr) => (tr.length > (single ? 1 : 0) ? tr.slice(0, -1) : tr));
    setSelected(null);
  }, [single]);

  // ⌘↑ : dossier parent, comme dans le Finder.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === "ArrowUp") {
        event.preventDefault();
        up();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [up]);

  const rows = current ? (children ?? []) : roots;
  const sorted = [...rows].sort((a, b) => {
    const d = sort.column === "name" ? a.name.localeCompare(b.name) : a.size - b.size;
    return sort.direction === "ascending" ? d : -d;
  });
  const largest = Math.max(1, ...rows.map((n) => n.size));
  const shownTotal = current ? current.size : rows.reduce((s, n) => s + n.size, 0);

  const crumbs: Crumb[] = [
    ...(single ? [] : [{ id: "root", label: t("sidebar.folders") }]),
    ...trail.map((n, i) => ({ id: String(i), label: n.name })),
  ];
  const goTo = (id: string) => {
    setTrail((tr) => (id === "root" ? [] : tr.slice(0, Number(id) + 1)));
    setSelected(null);
  };

  const menu = (n: NodeView): MenuEntry[] => [
    ...(isOpenable(n) ? [{ id: "open", label: t("action.open"), icon: FolderOpen, onSelect: () => open(n) }] : []),
    {
      id: "reveal",
      label: t("action.reveal"),
      icon: FolderSearch,
      onSelect: () => void api.showInFinder({ kind: "node", nodeId: n.id }),
    },
    { id: "copy", label: t("action.copy_path"), icon: Copy, onSelect: () => void api.copyText({ text: n.path }) },
    ...(current
      ? [
          {
            id: "trash",
            label: t("action.trash_ellipsis"),
            icon: Trash2,
            destructive: true,
            disabledReason: removalBlocked,
            onSelect: () => onRemove([{ nodeId: n.id, path: n.path, size: n.size }]),
          },
        ]
      : []),
  ];

  const nameOf = (n: NodeView) => (
    <span className={styles.name}>
      <Icon icon={!current ? HardDrive : n.isGitRepo ? FolderGit2 : n.isDirectory ? Folder : File} size={15} />
      <MiddleText text={n.name} />
      {n.category !== "source" && <CategoryTag category={n.category} label={categoryShort(n.category)} />}
    </span>
  );

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <IconButton
          icon={ArrowUp}
          label={t("explorer.parent")}
          onClick={up}
          disabledReason={trail.length > (single ? 1 : 0) ? undefined : t("storage.explorer.at_top")}
        />
        <div className={styles.crumbs}>
          <FolderBreadcrumb items={crumbs} onSelect={goTo} label={t("storage.explorer.path")} />
        </div>
        <span className={styles.count}>{t("explorer.items", Fmt.count(rows.length), Fmt.bytes(shownTotal))}</span>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {current && children === null && !error ? (
        <div className={styles.loading}>
          <Spinner size="regular" label={t("storage.explorer.loading")} />
        </div>
      ) : (
        <Table
          label={t("tab.explorer")}
          rows={sorted}
          rowKey={(n) => String(n.id)}
          sort={sort}
          onSortChange={setSort}
          selected={selected}
          onSelect={setSelected}
          onActivate={(key) => {
            const n = rows.find((x) => String(x.id) === key);
            if (!n) return;
            if (isOpenable(n)) open(n);
            else void api.showInFinder({ kind: "node", nodeId: n.id });
          }}
          rowMenu={menu}
          rowMenuLabel={t("git.more")}
          empty={t("storage.explorer.empty")}
          columns={[
            { id: "name", header: t("col.name"), sortable: true, width: "minmax(0, 1.5fr)", render: nameOf },
            {
              id: "breakdown",
              header: t("col.breakdown"),
              width: "minmax(120px, 1fr)",
              render: (n) => (
                <BreakdownBar
                  scale={largest}
                  label={t("storage.explorer.bar", n.name)}
                  parts={CATEGORY_KEYS.map((c, i) => ({ key: c, value: n.breakdown[i] ?? 0, color: categoryColor(c) }))}
                />
              ),
            },
            {
              id: "regenerable",
              header: t("col.regenerable"),
              align: "end",
              width: "100px",
              render: (n) => {
                const r = n.regenerable ? n.size : regenerableBytes(n);
                return r > 0 ? <span className={styles.secondary}>{Fmt.bytes(r)}</span> : "—";
              },
            },
            {
              id: "size",
              header: t("col.size"),
              sortable: true,
              align: "end",
              width: "84px",
              render: (n) => Fmt.bytes(n.size),
            },
            {
              id: "share",
              header: t("storage.col.share"),
              align: "end",
              width: "64px",
              render: (n) => <span className={styles.secondary}>{Fmt.percent(n.size, shownTotal)}</span>,
            },
          ]}
        />
      )}
    </div>
  );
}
