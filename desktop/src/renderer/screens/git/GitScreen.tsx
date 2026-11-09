// Écran Git : dépôts, branches et worktrees, affichés au fil de l'analyse (lecture seule) ; chaque suppression part
// du menu « … » de sa ligne, rien n'est présélectionné, et chaque action passe par une confirmation.
import { Copy, FolderOpen, GitBranch, Package, RefreshCw, ScanSearch, Settings2, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import type { GoneBranch, WorktreeInfo } from "../../../core/git/types.ts";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot, RepoReport } from "../../../shared/contract.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { PillPicker } from "../../ui/PillPicker.tsx";
import type { MenuEntry } from "../../ui/PopupMenu.tsx";
import { ProgressBar } from "../../ui/ProgressBar.tsx";
import { Stat } from "../../ui/Stat.tsx";
import { Table, type TableSort } from "../../ui/Table.tsx";
import type { ScreenProps } from "../types.ts";
import {
  atRisk,
  badge,
  baseName,
  branchBlocked,
  branchTone,
  deletionBlocked,
  obsolete,
  parentOf,
  repoAtRisk,
  shortDate,
  worktreeTone,
} from "./common.ts";
import styles from "./GitScreen.module.css";
import { type GitAction, GitSheet } from "./GitSheets.tsx";
import { OptionsSheet } from "./OptionsSheet.tsx";

type Tab = "repos" | "branches" | "worktrees";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const time = (d: Date | string | number | null) => (d === null ? 0 : new Date(d).getTime());

function sorted<T>(rows: readonly T[], sort: TableSort, values: Record<string, (row: T) => number | string>): T[] {
  const value = values[sort.column];
  if (!value) return [...rows];
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const d = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return sort.direction === "ascending" ? d : -d;
  });
}

export function GitScreen(props: ScreenProps) {
  const snapshot = useSnapshot();
  if (!snapshot) return <div data-testid="screen-git" className={styles.screen} />;
  return <GitContent {...props} snapshot={snapshot} />;
}

function GitContent({ request, snapshot }: ScreenProps & { snapshot: AppSnapshot }) {
  const api = useApi();
  const git = snapshot.git;
  const [tab, setTab] = useState<Tab>("repos");
  const [repoFilter, setRepoFilter] = useState<string | null>(request?.route === "git" ? (request.ref ?? null) : null);
  const [action, setAction] = useState<GitAction | null>(null);
  const [busyRepo, setBusyRepo] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [options, setOptions] = useState(false);
  const [repoSort, setRepoSort] = useState<TableSort>({ column: "git", direction: "descending" });
  const [branchSort, setBranchSort] = useState<TableSort>({ column: "date", direction: "ascending" });
  const [worktreeSort, setWorktreeSort] = useState<TableSort>({ column: "modified", direction: "ascending" });
  const lastRequest = useRef(request);

  useEffect(() => {
    if (request === lastRequest.current) return;
    lastRequest.current = request;
    if (request?.route === "git" && request.ref) setRepoFilter(request.ref);
  }, [request]);

  const analyze = (only?: string) => {
    setNotice(null);
    api.gitAnalyze(only ? { only } : {}).catch((e: unknown) => setNotice({ tone: "danger", text: errorText(e) }));
  };

  const reports = repoFilter ? git.reports.filter((r) => r.path === repoFilter) : git.reports;
  const branches = reports.flatMap((r) => r.branches);
  const worktrees = reports.flatMap((r) => r.worktrees);
  const reportOf = (repo: string) => git.reports.find((r) => r.path === repo);
  const failed = Object.entries(git.failed);

  const confirm = async (a: GitAction, { withBranch }: { withBranch: boolean }) => {
    const repo = a.kind === "branch" ? a.branch.repo : a.kind === "worktree" ? a.worktree.repo : a.report.path;
    setBusyRepo(repo);
    try {
      if (a.kind === "branch" || a.kind === "worktree") {
        const selection =
          a.kind === "branch"
            ? { repo, branches: [a.branch.name], worktrees: [] }
            : {
                repo,
                branches: withBranch && a.worktree.branch ? [a.worktree.branch] : [],
                worktrees: [a.worktree.path],
              };
        const result = await api.gitApply({ selections: [selection] });
        if (!result.cancelled && result.value) {
          const v = result.value;
          setNotice(
            v.failures.length > 0
              ? { tone: "danger", text: t("git.page.failures", v.failures.length) }
              : { tone: "success", text: t("git.done", v.deletedBranches.length, v.removedWorktrees.length) },
          );
        }
      } else if (a.kind === "compact") {
        const result = await api.gitCompact({ repo });
        if (!result.cancelled) setNotice({ tone: "success", text: t("git.page.compacted", baseName(repo)) });
      } else {
        const result = await api.gitTrashRepo({ repo });
        if (!result.cancelled) {
          setNotice({ tone: "success", text: t("git.trashed", baseName(repo)) });
          if (repoFilter === repo) setRepoFilter(null);
        }
      }
      setAction(null);
    } catch (e) {
      setAction(null);
      setNotice({ tone: "danger", text: errorText(e) });
    } finally {
      setBusyRepo(null);
    }
  };

  // MARK: Menus de ligne

  const repoMenu = (r: RepoReport): MenuEntry[] => {
    const blocked = deletionBlocked(git, busyRepo, r.path);
    return [
      {
        id: "reveal",
        label: t("git.action.reveal"),
        icon: FolderOpen,
        onSelect: () => void api.showInFinder({ kind: "path", path: r.path }),
      },
      {
        id: "copy",
        label: t("git.action.copy_path"),
        icon: Copy,
        onSelect: () => void api.copyText({ text: r.path }),
      },
      {
        id: "only",
        label: t("git.action.only_repo"),
        icon: ScanSearch,
        disabledReason: git.running ? t("git.action.wait_analysis") : undefined,
        onSelect: () => {
          setRepoFilter(r.path);
          analyze(r.path);
        },
      },
      {
        id: "compact",
        label: t("git.action.compact"),
        icon: Package,
        disabledReason: blocked,
        onSelect: () => setAction({ kind: "compact", report: r }),
      },
      {
        id: "trash",
        label: t("git.action.trash_repo"),
        icon: Trash2,
        destructive: true,
        disabledReason: blocked,
        onSelect: () => setAction({ kind: "trash", report: r }),
      },
    ];
  };

  const branchMenu = (b: GoneBranch): MenuEntry[] => [
    { id: "copy", label: t("git.action.copy_name"), icon: Copy, onSelect: () => void api.copyText({ text: b.name }) },
    {
      id: "delete",
      label: t("git.action.delete_branch"),
      icon: Trash2,
      destructive: true,
      disabledReason: branchBlocked(git, busyRepo, b),
      onSelect: () => setAction({ kind: "branch", branch: b }),
    },
  ];

  const worktreeMenu = (w: WorktreeInfo): MenuEntry[] => [
    {
      id: "reveal",
      label: t("git.action.reveal"),
      icon: FolderOpen,
      disabledReason: w.exists ? undefined : t("git.page.missing_folder"),
      onSelect: () => void api.showInFinder({ kind: "path", path: w.path }),
    },
    { id: "copy", label: t("git.action.copy_path"), icon: Copy, onSelect: () => void api.copyText({ text: w.path }) },
    {
      id: "delete",
      label: t("git.action.delete_worktree"),
      icon: Trash2,
      destructive: true,
      disabledReason: deletionBlocked(git, busyRepo, w.repo),
      onSelect: () => {
        const report = reportOf(w.repo);
        if (report) setAction({ kind: "worktree", worktree: w, report });
      },
    },
  ];

  // MARK: Tableaux

  const repoName = (path: string) => (
    <span className={styles.stack}>
      <span className={styles.primary}>{baseName(path)}</span>
      <MiddleText text={parentOf(path)} className={styles.monoSmall} />
    </span>
  );

  const repoTable = (
    <Table
      label={t("git.tab.repos")}
      rows={sorted(reports, repoSort, {
        repo: (r) => baseName(r.path).toLowerCase(),
        activity: (r) => time(r.lastModified),
        git: (r) => r.gitBytes,
        loose: (r) => r.looseBytes,
        branches: (r) => r.branches.length,
        worktrees: (r) => r.worktrees.length,
        reclaimable: (r) => r.reclaimableBytes,
      })}
      rowKey={(r) => r.path}
      sort={repoSort}
      onSortChange={setRepoSort}
      onActivate={(path) => {
        setRepoFilter(path);
        setTab("branches");
      }}
      rowMenu={repoMenu}
      rowMenuLabel={t("git.more")}
      empty={t("git.page.no_repo")}
      columns={[
        {
          id: "repo",
          header: t("col.repo"),
          sortable: true,
          width: "minmax(0, 1.6fr)",
          render: (r) => (
            <span className={styles.withBadge}>
              {repoName(r.path)}
              {repoAtRisk(r) && <Badge tone="warning">{badge(t("worktree.status.risk"))}</Badge>}
            </span>
          ),
        },
        {
          id: "activity",
          header: t("git.col.activity"),
          sortable: true,
          width: "minmax(110px, 0.8fr)",
          render: (r) => shortDate(r.lastModified),
        },
        {
          id: "git",
          header: t("col.git"),
          sortable: true,
          align: "end",
          width: "84px",
          render: (r) => Fmt.bytes(r.gitBytes),
        },
        {
          id: "loose",
          header: t("git.col.loose"),
          sortable: true,
          align: "end",
          width: "110px",
          render: (r) => <span className={styles.secondary}>{Fmt.bytes(r.looseBytes)}</span>,
        },
        {
          id: "branches",
          header: t("git.tab.branches"),
          sortable: true,
          align: "end",
          width: "84px",
          render: (r) => r.branches.length || "—",
        },
        {
          id: "worktrees",
          header: t("git.tab.worktrees"),
          sortable: true,
          align: "end",
          width: "88px",
          render: (r) => r.worktrees.length || "—",
        },
        {
          id: "reclaimable",
          header: t("git.stat.reclaimable"),
          sortable: true,
          align: "end",
          width: "104px",
          render: (r) => (r.reclaimableBytes > 0 ? Fmt.bytes(r.reclaimableBytes) : "—"),
        },
      ]}
    />
  );

  const branchTable = (
    <Table
      label={t("git.tab.branches")}
      rows={sorted(branches, branchSort, {
        repo: (b) => baseName(b.repo).toLowerCase(),
        branch: (b) => b.name.toLowerCase(),
        status: (b) => b.status,
        date: (b) => time(b.date),
      })}
      rowKey={(b) => `${b.repo}#${b.name}`}
      sort={branchSort}
      onSortChange={setBranchSort}
      rowMenu={branchMenu}
      rowMenuLabel={t("git.more")}
      empty={git.running ? t("git.analyzing") : t("git.branches.empty")}
      columns={[
        {
          id: "repo",
          header: t("col.repo"),
          sortable: true,
          width: "minmax(0, 0.8fr)",
          render: (b) => <span className={styles.primary}>{baseName(b.repo)}</span>,
        },
        {
          id: "branch",
          header: t("git.col.branch"),
          sortable: true,
          width: "minmax(0, 1.3fr)",
          render: (b) => (
            <span className={styles.stack}>
              <MiddleText text={b.name} className={styles.mono} />
              {b.checkedOutInWorktree && (
                <span className={styles.hint}>{t("git.branch.in_worktree", baseName(b.checkedOutInWorktree))}</span>
              )}
            </span>
          ),
        },
        {
          id: "status",
          header: t("col.status"),
          sortable: true,
          width: "120px",
          render: (b) => <Badge tone={branchTone[b.status]}>{badge(t(`branch.status.${b.status}`))}</Badge>,
        },
        {
          id: "date",
          header: t("git.col.last_commit"),
          sortable: true,
          width: "120px",
          render: (b) => shortDate(b.date),
        },
        {
          id: "subject",
          header: t("git.col.subject"),
          width: "minmax(0, 1.4fr)",
          render: (b) => <span className={styles.ellipsis}>{b.subject}</span>,
        },
      ]}
    />
  );

  const worktreeTable = (
    <Table
      label={t("git.tab.worktrees")}
      rows={sorted(worktrees, worktreeSort, {
        worktree: (w) => baseName(w.path).toLowerCase(),
        branch: (w) => w.branch ?? "",
        modified: (w) => time(w.lastModified),
        size: (w) => w.size,
      })}
      rowKey={(w) => w.path}
      sort={worktreeSort}
      onSortChange={setWorktreeSort}
      rowMenu={worktreeMenu}
      rowMenuLabel={t("git.more")}
      empty={git.running ? t("git.analyzing") : t("git.worktrees.empty")}
      columns={[
        {
          id: "worktree",
          header: t("git.col.worktree"),
          sortable: true,
          width: "minmax(0, 1.3fr)",
          render: (w) => (
            <span className={styles.stack}>
              <MiddleText text={baseName(w.path)} className={styles.primary} />
              <MiddleText text={baseName(w.repo)} className={styles.monoSmall} />
            </span>
          ),
        },
        {
          id: "branch",
          header: t("git.col.branch"),
          sortable: true,
          width: "minmax(0, 1fr)",
          render: (w) => <MiddleText text={w.branch ?? "—"} className={styles.mono} />,
        },
        {
          id: "status",
          header: t("col.status"),
          width: "minmax(0, 1.3fr)",
          render: (w) => (
            <span className={styles.stack}>
              <span>
                <Badge tone={worktreeTone(w)}>{badge(t(`worktree.status.${atRisk(w) ? "risk" : w.status}`))}</Badge>
              </span>
              {atRisk(w) && (
                <span className={styles.hint}>
                  {t("git.risk_detail", w.modifiedFiles + w.untrackedFiles, w.unpushedCommits)}
                </span>
              )}
            </span>
          ),
        },
        {
          id: "modified",
          header: t("git.col.modified"),
          sortable: true,
          width: "110px",
          render: (w) => shortDate(w.lastModified),
        },
        {
          id: "size",
          header: t("col.size"),
          sortable: true,
          align: "end",
          width: "84px",
          render: (w) => (w.exists ? Fmt.bytes(w.size) : "—"),
        },
      ]}
    />
  );

  // MARK: Page

  const progress = git.progress;
  const allWorktrees = reports.flatMap((r) => r.worktrees);
  const stats = (
    <div className={styles.stats}>
      <Card>
        <Stat
          label={t("git.stat.repos")}
          value={Fmt.count(reports.length)}
          detail={t("git.page.at_risk", reports.filter(repoAtRisk).length)}
        />
      </Card>
      <Card>
        <Stat
          label={t("git.stat.git_total")}
          value={Fmt.bytes(reports.reduce((s, r) => s + r.gitBytes, 0))}
          detail={t("git.page.loose", Fmt.bytes(reports.reduce((s, r) => s + r.looseBytes, 0)))}
        />
      </Card>
      <Card>
        <Stat
          label={t("git.page.stat.branches")}
          value={Fmt.count(branches.length)}
          detail={t("git.page.unmerged", branches.filter((b) => b.status === "unmerged").length)}
        />
      </Card>
      <Card>
        <Stat
          label={t("git.stat.worktrees")}
          value={Fmt.count(allWorktrees.length)}
          detail={t(
            "git.page.worktrees_detail",
            allWorktrees.filter(obsolete).length,
            allWorktrees.filter(atRisk).length,
          )}
        />
      </Card>
      <Card>
        <Stat
          label={t("git.stat.reclaimable")}
          value={Fmt.bytes(reports.reduce((s, r) => s + r.reclaimableBytes, 0))}
          detail={t("git.page.reclaimable_detail")}
        />
      </Card>
    </div>
  );

  const header = (
    <PageHeader
      heading={t("section.git")}
      subtitle={
        git.running
          ? progress && progress.total > 0
            ? t("git.live.progress", progress.done, progress.total)
            : t("git.live.discovering")
          : git.finishedAt
            ? t("git.page.analyzed_on", Fmt.date(new Date(git.finishedAt)))
            : t("git.simulation_default")
      }
      actions={
        <>
          <Button icon={Settings2} onClick={() => setOptions(true)}>
            {t("git.page.options")}
          </Button>
          {git.running ? (
            <Button icon={X} onClick={() => void api.gitCancel()}>
              {t("action.stop")}
            </Button>
          ) : (
            git.reports.length > 0 && (
              <Button icon={RefreshCw} help={t("git.simulation_default")} onClick={() => analyze()}>
                {t("git.reanalyze")}
              </Button>
            )
          )}
        </>
      }
    >
      {git.reports.length > 0 && (
        <PillPicker<Tab>
          label={t("section.git")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "repos", label: `${t("git.tab.repos")}` },
            { value: "branches", label: t("git.tab.branches") },
            { value: "worktrees", label: t("git.tab.worktrees") },
          ]}
        />
      )}
      {repoFilter && (
        <span className={styles.filter}>
          <span className={styles.filterText}>
            <MiddleText text={t("git.filter.repo", baseName(repoFilter))} />
          </span>
          <Button icon={X} onClick={() => setRepoFilter(null)}>
            {t("git.filter.all")}
          </Button>
        </span>
      )}
    </PageHeader>
  );

  let body: ReactNode;
  if (git.reports.length === 0 && git.running) {
    body = (
      <EmptyState
        busy
        heading={progress?.total ? t("git.live.progress", progress.done, progress.total) : t("git.live.discovering")}
      >
        {t("git.simulation_default")}
      </EmptyState>
    );
  } else if (git.reports.length === 0) {
    body = (
      <EmptyState
        icon={GitBranch}
        heading={git.finishedAt ? t("git.page.no_repo") : t("git.page.empty_title")}
        actions={
          <Button
            variant="primary"
            onClick={() => analyze()}
            disabledReason={snapshot.config.config.folders.length === 0 ? t("git.page.no_folder") : undefined}
          >
            {t("git.analyze")}
          </Button>
        }
      >
        {t("git.intro")}
      </EmptyState>
    );
  } else {
    body = (
      <>
        {stats}
        {tab === "repos" ? repoTable : tab === "branches" ? branchTable : worktreeTable}
      </>
    );
  }

  return (
    <div data-testid="screen-git" data-tab={tab} className={styles.screen}>
      {header}
      {git.running && git.reports.length > 0 && progress && (
        <div className={styles.progress}>
          <span className={styles.progressBar}>
            <ProgressBar
              label={t("git.analyzing")}
              value={progress.total > 0 ? progress.done / progress.total : undefined}
            />
          </span>
          <span className={styles.secondary}>{t("git.page.running_note")}</span>
        </div>
      )}
      {git.error && <Banner tone="danger">{git.error}</Banner>}
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {failed.length > 0 && (
        <Banner tone="warning">
          <strong>{t("git.page.failed", failed.length)}</strong>
          <ul className={styles.failedList}>
            {failed.slice(0, 3).map(([repo, reason]) => (
              <li key={repo}>
                {baseName(repo)} — {reason}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {body}
      <GitSheet
        action={action}
        busy={busyRepo !== null}
        onCancel={() => setAction(null)}
        onConfirm={(a, o) => void confirm(a, o)}
      />
      <OptionsSheet open={options} onClose={() => setOptions(false)} snapshot={snapshot} />
    </div>
  );
}
