// Onglet « Vue d'ensemble » : chiffres clés, répartition par type, gros objets, projets les plus lourds.
import { Copy, File, Folder, FolderSearch, Trash2 } from "lucide-react";
import { useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { AnalysisView, StorageView } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { BreakdownChart } from "../../ui/BreakdownChart.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { CategoryTag } from "../../ui/CategoryTag.tsx";
import { CATEGORY_KEYS } from "../../ui/categories.ts";
import { Icon } from "../../ui/Icon.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import type { MenuEntry } from "../../ui/PopupMenu.tsx";
import { SectionTitle } from "../../ui/SectionTitle.tsx";
import { Stat } from "../../ui/Stat.tsx";
import { Table, type TableSort } from "../../ui/Table.tsx";
import { baseName, categoryColor, categoryLabel, categoryShort, parentOf, REGENERABLE } from "./common.ts";
import styles from "./Overview.module.css";
import { ProjectsTable } from "./ProjectsTable.tsx";
import type { RemovalItem } from "./RemoveSheet.tsx";

type BigObject = AnalysisView["bigObjects"][number];

export interface OverviewProps {
  analysis: AnalysisView;
  storage: StorageView;
  /** Raison pour laquelle rien ne peut être supprimé maintenant (analyse en cours…). */
  removalBlocked: string | undefined;
  onRemove: (items: RemovalItem[]) => void;
  onShowProjects: () => void;
  onClean: () => void;
  onGitMaintenance: (repo: string) => void;
}

export function Overview({
  analysis,
  storage,
  removalBlocked,
  onRemove,
  onShowProjects,
  onClean,
  onGitMaintenance,
}: OverviewProps) {
  const api = useApi();
  const [sort, setSort] = useState<TableSort>({ column: "size", direction: "descending" });
  const roots = analysis.folders.flatMap((f) => (f.root ? [f.root] : []));
  const total = roots.reduce((sum, r) => sum + r.size, 0);
  const files = roots.reduce((sum, r) => sum + r.fileCount, 0);
  const byCategory = CATEGORY_KEYS.map((c, i) => ({ c, bytes: roots.reduce((s, r) => s + (r.breakdown[i] ?? 0), 0) }));
  const reclaimable = byCategory.filter((x) => REGENERABLE.includes(x.c)).reduce((s, x) => s + x.bytes, 0);

  const bigFiles = analysis.bigObjects.filter((o) => o.kind === "file");
  const bigFolders = analysis.bigObjects.filter((o) => o.kind === "folder");
  const rows = [...analysis.bigObjects].sort((a, b) => {
    const d = sort.column === "name" ? baseName(a.path).localeCompare(baseName(b.path)) : a.size - b.size;
    return sort.direction === "ascending" ? d : -d;
  });

  const bigMenu = (o: BigObject): MenuEntry[] => [
    {
      id: "reveal",
      label: t("action.reveal"),
      icon: FolderSearch,
      onSelect: () => void api.showInFinder({ kind: "path", path: o.path }),
    },
    { id: "copy", label: t("action.copy_path"), icon: Copy, onSelect: () => void api.copyText({ text: o.path }) },
    {
      id: "trash",
      label: t("action.trash_ellipsis"),
      icon: Trash2,
      destructive: true,
      disabledReason: removalBlocked ?? (o.nodeId === null ? t("storage.unavailable.not_in_tree") : undefined),
      onSelect: () => o.nodeId !== null && onRemove([{ nodeId: o.nodeId, path: o.path, size: o.size }]),
    },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.top}>
        <section className={styles.chart} aria-label={t("sidebar.by_type")}>
          <Card>
            <BreakdownChart
              label={t("sidebar.by_type")}
              total={Fmt.bytes(total)}
              caption={t("stat.files", Fmt.count(files))}
              items={byCategory.map((x) => ({
                key: x.c,
                label: categoryLabel(x.c),
                value: x.bytes,
                valueLabel: Fmt.bytes(x.bytes),
                color: categoryColor(x.c),
              }))}
            />
          </Card>
        </section>
        <div className={styles.stats}>
          <Card fill>
            <div className={styles.statWithAction}>
              <Stat
                label={t("home.reclaimable")}
                value={Fmt.bytes(reclaimable)}
                detail={t("storage.stat.reclaimable_detail", Fmt.percent(reclaimable, total))}
              />
              {reclaimable > 0 && (
                <Button variant="outline" onClick={onClean}>
                  {t("action.clean")}
                </Button>
              )}
            </div>
          </Card>
          <Card fill>
            <Stat
              label={t("storage.stat.free")}
              value={storage.freeBytes === null ? "—" : Fmt.bytes(storage.freeBytes)}
              detail={t("storage.stat.free_detail")}
            />
          </Card>
          <Card fill>
            <Stat
              label={t("tab.projects")}
              value={Fmt.count(analysis.projects.length)}
              detail={t("storage.stat.big_objects", analysis.bigObjects.length)}
            />
          </Card>
        </div>
      </div>

      <section className={styles.section}>
        <SectionTitle label={t("sidebar.heaviest")}>
          {analysis.projects.length > 5 && (
            <Button onClick={onShowProjects}>{t("storage.projects.all", analysis.projects.length)}</Button>
          )}
        </SectionTitle>
        <ProjectsTable projects={analysis.projects.slice(0, 5)} sortable={false} onGitMaintenance={onGitMaintenance} />
      </section>

      <section className={styles.section}>
        <SectionTitle label={t("tab.big_objects")}>
          <span className={styles.meta}>{t("storage.big_objects.count", bigFiles.length, bigFolders.length)}</span>
        </SectionTitle>
        <Table
          label={t("tab.big_objects")}
          rows={rows}
          rowKey={(o) => o.path}
          sort={sort}
          onSortChange={setSort}
          rowMenu={bigMenu}
          rowMenuLabel={t("git.more")}
          empty={t("storage.big_objects.empty")}
          columns={[
            {
              id: "name",
              header: t("col.name"),
              sortable: true,
              width: "minmax(0, 1.2fr)",
              render: (o) => (
                <span className={styles.name}>
                  <Icon icon={o.kind === "file" ? File : Folder} size={15} />
                  <MiddleText text={baseName(o.path)} />
                </span>
              ),
            },
            {
              id: "location",
              header: t("col.location"),
              width: "minmax(0, 1.6fr)",
              render: (o) => <MiddleText text={parentOf(o.path)} className={styles.mono} />,
            },
            {
              id: "kind",
              header: t("col.type"),
              width: "130px",
              render: (o) => <CategoryTag category={o.category} label={categoryShort(o.category)} />,
            },
            {
              id: "size",
              header: t("col.size"),
              sortable: true,
              align: "end",
              width: "90px",
              render: (o) => Fmt.bytes(o.size),
            },
          ]}
        />
      </section>
    </div>
  );
}
