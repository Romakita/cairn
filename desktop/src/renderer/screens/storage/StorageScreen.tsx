// Écran Analyse (routes `storage`, `explorer`, `clean`) : onglets Vue d'ensemble · Explorateur · Nettoyable ·
// Projets ; états vide, analyse en cours, disque critique, analyse ancienne ; suppression confirmée (corbeille).
import { FolderPlus, HardDrive, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot, Route } from "../../../shared/contract.ts";
import { confirmedCall } from "../../api/confirm.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { PillPicker } from "../../ui/PillPicker.tsx";
import { ProgressBar } from "../../ui/ProgressBar.tsx";
import type { ScreenProps } from "../types.ts";
import { Cleanable } from "./Cleanable.tsx";
import { Explorer } from "./Explorer.tsx";
import { Overview } from "./Overview.tsx";
import { ProjectsTable } from "./ProjectsTable.tsx";
import { type RemovalItem, RemoveSheet } from "./RemoveSheet.tsx";
import styles from "./StorageScreen.module.css";

type Tab = "overview" | "explorer" | "clean" | "projects";

const TAB_OF_ROUTE: Partial<Record<Route, Tab>> = { storage: "overview", explorer: "explorer", clean: "clean" };
const ROUTE_OF_TAB: Partial<Record<Tab, Route>> = { overview: "storage", explorer: "explorer", clean: "clean" };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function StorageScreen({ route, request, navigate }: ScreenProps) {
  const snapshot = useSnapshot();
  if (!snapshot) return <div data-testid="screen-storage" className={styles.screen} />;
  return <StorageContent snapshot={snapshot} route={route} request={request} navigate={navigate} />;
}

function StorageContent({ snapshot, route, request, navigate }: ScreenProps & { snapshot: AppSnapshot }) {
  const api = useApi();
  const { analysis, storage, config } = snapshot;
  const [tab, setTab] = useState<Tab>(TAB_OF_ROUTE[route] ?? "overview");
  const [selection, setSelection] = useState<Set<number>>(() => new Set(request?.preselect ?? []));
  const [preselected, setPreselected] = useState(Boolean(request?.preselect?.length));
  const [removal, setRemoval] = useState<RemovalItem[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const lastRequest = useRef(request);

  // Navigation reçue (onglet, présélection depuis une alerte ou la barre des menus).
  useEffect(() => {
    if (request === lastRequest.current) return;
    lastRequest.current = request;
    const next = request ? TAB_OF_ROUTE[request.route] : undefined;
    if (next) setTab(next);
    if (request?.preselect) {
      setSelection(new Set(request.preselect));
      setPreselected(request.preselect.length > 0);
    }
  }, [request]);

  const choose = (next: Tab) => {
    setTab(next);
    const r = ROUTE_OF_TAB[next];
    if (r && r !== route) navigate({ route: r });
  };

  const rescan = () => {
    setNotice(null);
    api.scan({}).catch((e: unknown) => setNotice({ tone: "danger", text: errorText(e) }));
  };

  const confirmRemoval = async (permanently: boolean) => {
    if (!removal) return;
    setRemoving(true);
    try {
      const outcome = await confirmedCall(api, "removeNodes", {
        nodeIds: removal.map((i) => i.nodeId),
        permanently,
      });
      if (!outcome.cancelled) {
        const gone = new Set(removal.map((i) => i.nodeId));
        setSelection((s) => new Set([...s].filter((id) => !gone.has(id))));
        setReloadKey((k) => k + 1);
        setNotice(
          outcome.failures.length > 0
            ? {
                tone: "danger",
                text: t("storage.removed.failures", outcome.failures.length, outcome.failures[0]!.path),
              }
            : { tone: "success", text: t("storage.removed", outcome.removed, Fmt.bytes(outcome.freed)) },
        );
      }
      setRemoval(null);
    } catch (e) {
      setRemoval(null);
      setNotice({ tone: "danger", text: errorText(e) });
    } finally {
      setRemoving(false);
    }
  };

  const hasResults = analysis.folders.some((f) => f.root !== null);
  const roots = analysis.folders.map((f) => f.folder);
  const removalBlocked = analysis.running ? t("storage.unavailable.scanning") : undefined;
  const alert = storage.alerts.find((a) => a.level === 2) ?? storage.alerts[0];
  const unavailable = analysis.folders.filter((f) => !f.available);
  const date = analysis.summary?.date ?? (analysis.finishedAt ? new Date(analysis.finishedAt) : null);

  const header = (
    <PageHeader
      heading={t("section.analysis")}
      subtitle={
        analysis.running
          ? t("storage.analyzing")
          : date
            ? t("storage.analyzed_on", Fmt.date(new Date(date)))
            : t("menu.no_analysis")
      }
      actions={
        hasResults &&
        !analysis.running && (
          <Button icon={RefreshCw} onClick={rescan} help={t("storage.rescan.help")}>
            {t("action.rescan")}
          </Button>
        )
      }
    >
      {hasResults && (
        <PillPicker<Tab>
          label={t("section.analysis")}
          value={tab}
          onChange={choose}
          options={[
            { value: "overview", label: t("storage.tab.overview") },
            { value: "explorer", label: t("tab.explorer") },
            { value: "clean", label: t("tab.cleanable") },
            { value: "projects", label: t("tab.projects") },
          ]}
        />
      )}
    </PageHeader>
  );

  const banners = (
    <>
      {alert && (
        <Banner
          tone={alert.level === 2 ? "danger" : "warning"}
          action={
            <div className={styles.bannerActions}>
              <Button variant="outline" onClick={() => api.snoozeAlert({ volume: alert.volume })}>
                {t("alerts.snooze")}
              </Button>
              {tab !== "clean" && analysis.regenerable.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSelection(new Set(analysis.preselection));
                    setPreselected(analysis.preselection.length > 0);
                    choose("clean");
                  }}
                >
                  {t("action.clean")}
                </Button>
              )}
            </div>
          }
        >
          <strong>
            {alert.level === 2 ? t("alerts.critical_title", alert.volume) : t("alerts.low_title", alert.volume)}
          </strong>{" "}
          {t("menubar.alert_body", Fmt.bytes(alert.available), Fmt.percent(alert.percentFree, 100))}
          {alert.daysToFull !== null && ` ${t("alerts.forecast", alert.daysToFull)}`}
        </Banner>
      )}
      {analysis.error && <Banner tone="danger">{analysis.error}</Banner>}
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {unavailable.map((f) => (
        <Banner key={f.folder} tone="warning">
          {t("hub.issue.folder_unavailable", f.folder)}
        </Banner>
      ))}
      {analysis.stale && hasResults && !analysis.running && (
        <Banner
          tone="info"
          action={
            <Button variant="outline" onClick={rescan}>
              {t("action.rescan")}
            </Button>
          }
        >
          {t("storage.stale")}
        </Banner>
      )}
    </>
  );

  let body: ReactNode;
  if (analysis.running) {
    const p = analysis.progress;
    const folder = roots[0] ?? "";
    body = (
      <EmptyState
        busy
        heading={t("scan.progress_title", folder.split("/").filter(Boolean).at(-1) ?? folder)}
        actions={<Button onClick={() => void api.cancelScan()}>{t("action.stop")}</Button>}
      >
        <span className={styles.progressLine}>
          {t("scan.progress", Fmt.count(p?.files ?? 0), Fmt.bytes(p?.bytes ?? 0))}
          {p && p.errors > 0 && ` · ${t("storage.scan.unreadable", p.errors)}`}
        </span>
        <span className={styles.progressBar}>
          <ProgressBar label={t("storage.analyzing")} />
        </span>
        {p?.current && <MiddleText text={p.current} className={styles.current} />}
      </EmptyState>
    );
  } else if (config.config.folders.length === 0) {
    body = (
      <EmptyState
        icon={FolderPlus}
        heading={t("storage.empty.no_folder.title")}
        actions={
          <Button variant="primary" icon={FolderPlus} onClick={() => navigate({ route: "settings" })}>
            {t("sidebar.add_folder")}
          </Button>
        }
      >
        {t("storage.empty.no_folder.text")}
      </EmptyState>
    );
  } else if (!hasResults) {
    body = (
      <EmptyState
        icon={HardDrive}
        heading={t("empty.title")}
        actions={
          <Button variant="primary" onClick={rescan}>
            {t("action.analyze")}
          </Button>
        }
      >
        <span>{t("storage.empty.text")}</span>
        <MiddleText text={config.config.folders.map((f) => f.path).join(" · ")} className={styles.current} />
      </EmptyState>
    );
  } else if (tab === "overview") {
    body = (
      <Overview
        analysis={analysis}
        storage={storage}
        removalBlocked={removalBlocked}
        onRemove={setRemoval}
        onShowProjects={() => choose("projects")}
        onClean={() => choose("clean")}
        onGitMaintenance={(repo) => navigate({ route: "git", ref: repo })}
      />
    );
  } else if (tab === "explorer") {
    body = (
      <Explorer
        folders={analysis.folders}
        initialFolder={request?.route === "explorer" ? request.ref : undefined}
        reloadKey={reloadKey}
        removalBlocked={removalBlocked}
        onRemove={setRemoval}
      />
    );
  } else if (tab === "clean") {
    body = (
      <Cleanable
        nodes={analysis.regenerable}
        roots={roots}
        selection={selection}
        onSelectionChange={(s) => {
          setSelection(s);
          setPreselected(false);
        }}
        preselected={preselected}
        removalBlocked={removalBlocked}
        onRemove={setRemoval}
      />
    );
  } else {
    body = (
      <div className={styles.projects}>
        <span className={styles.meta}>{t("projects.count", Fmt.count(analysis.projects.length))}</span>
        <ProjectsTable
          projects={analysis.projects}
          onGitMaintenance={(repo) => navigate({ route: "git", ref: repo })}
        />
      </div>
    );
  }

  return (
    <div data-testid="screen-storage" data-tab={tab} className={styles.screen}>
      {header}
      {banners}
      {body}
      <RemoveSheet
        items={removal}
        busy={removing}
        onCancel={() => setRemoval(null)}
        onConfirm={(permanently) => void confirmRemoval(permanently)}
      />
    </div>
  );
}
