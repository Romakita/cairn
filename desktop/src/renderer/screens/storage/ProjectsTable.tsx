// Tableau des projets (Vue d'ensemble et onglet Projets) : répartition sources / .git / régénérable / worktrees.
import { Copy, FolderGit2, FolderSearch } from "lucide-react";
import { useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { Project } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { MiddleText } from "../../ui/MiddleText.tsx";
import type { MenuEntry } from "../../ui/PopupMenu.tsx";
import { ProjectBar } from "../../ui/ProjectBar.tsx";
import { Table, type TableSort } from "../../ui/Table.tsx";
import { parentOf } from "./common.ts";
import styles from "./ProjectsTable.module.css";

export interface ProjectsTableProps {
  projects: readonly Project[];
  sortable?: boolean;
  onGitMaintenance: (repo: string) => void;
}

const worktreeBytes = (p: Project) => p.worktrees.reduce((s, w) => s + w.size, 0);
const totalOf = (p: Project) => p.size + worktreeBytes(p);

const VALUES: Record<string, (p: Project) => number | string> = {
  name: (p) => p.name.toLowerCase(),
  sources: (p) => p.source,
  git: (p) => p.git,
  regenerable: (p) => p.regenerable,
  worktrees: worktreeBytes,
  total: totalOf,
};

export function ProjectsTable({ projects, sortable = true, onGitMaintenance }: ProjectsTableProps) {
  const api = useApi();
  const [sort, setSort] = useState<TableSort>({ column: "total", direction: "descending" });
  const [selected, setSelected] = useState<string | null>(null);
  const value = VALUES[sort.column] ?? totalOf;
  const rows = sortable
    ? [...projects].sort((a, b) => {
        const x = value(a);
        const y = value(b);
        const d = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
        return sort.direction === "ascending" ? d : -d;
      })
    : projects;
  const scale = Math.max(1, ...projects.map(totalOf));

  const menu = (p: Project): MenuEntry[] => [
    {
      id: "reveal",
      label: t("action.reveal"),
      icon: FolderSearch,
      onSelect: () => void api.showInFinder({ kind: "path", path: p.path }),
    },
    { id: "copy", label: t("action.copy_path"), icon: Copy, onSelect: () => void api.copyText({ text: p.path }) },
    ...(p.isGitRepo
      ? [
          { kind: "separator" as const },
          {
            id: "git",
            label: t("action.git_maintenance"),
            icon: FolderGit2,
            onSelect: () => onGitMaintenance(p.path),
          },
        ]
      : []),
  ];

  return (
    <Table
      label={t("tab.projects")}
      rows={rows}
      rowKey={(p) => p.path}
      sort={sortable ? sort : undefined}
      onSortChange={sortable ? setSort : undefined}
      selected={selected}
      onSelect={setSelected}
      rowMenu={menu}
      rowMenuLabel={t("git.more")}
      empty={t("storage.projects.empty")}
      columns={[
        {
          id: "name",
          header: t("storage.col.project"),
          sortable: true,
          width: "minmax(0, 1.3fr)",
          render: (p) => (
            <span className={styles.project}>
              <span className={styles.name}>{p.name}</span>
              <MiddleText text={parentOf(p.path)} className={styles.parent} />
            </span>
          ),
        },
        {
          id: "breakdown",
          header: t("col.breakdown"),
          width: "minmax(0, 1fr)",
          render: (p) => (
            <ProjectBar
              sources={p.source}
              git={p.git}
              regenerable={p.regenerable}
              externalWorktrees={worktreeBytes(p)}
              scale={scale}
              label={t("storage.projects.bar", p.name)}
            />
          ),
        },
        {
          id: "sources",
          header: t("col.sources"),
          sortable: true,
          align: "end",
          width: "80px",
          render: (p) => Fmt.bytes(p.source),
        },
        {
          id: "git",
          header: t("col.git"),
          sortable: true,
          align: "end",
          width: "76px",
          render: (p) => (p.isGitRepo ? Fmt.bytes(p.git) : "—"),
        },
        {
          id: "regenerable",
          header: t("col.regenerable"),
          sortable: true,
          align: "end",
          width: "96px",
          render: (p) => Fmt.bytes(p.regenerable),
        },
        {
          id: "worktrees",
          header: t("col.worktrees"),
          sortable: true,
          align: "end",
          width: "110px",
          render: (p) => (p.worktrees.length > 0 ? `${p.worktrees.length} · ${Fmt.bytes(worktreeBytes(p))}` : "—"),
        },
        {
          id: "total",
          header: t("col.total"),
          sortable: true,
          align: "end",
          width: "80px",
          render: (p) => <strong className={styles.total}>{Fmt.bytes(totalOf(p))}</strong>,
        },
      ]}
    />
  );
}
