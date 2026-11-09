// Accueil (hub, §3.1 de parity/ui.md ; spec home-dashboard) : état global et ses causes, « Tout vérifier » (lecture
// seule, annulable), cartes de module colorées (style Avast), activité récente et problème prioritaire en bas.
import { CircleCheck, FolderOpen, FolderX, OctagonX, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import type { HubAction, HubModule, ModuleState } from "../../../core/hub-state.ts";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot, CairnApi, DestinationView, NavigationRequest } from "../../../shared/contract.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { FillBar } from "../../ui/FillBar.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { IconTile } from "../../ui/IconTile.tsx";
import { SegmentBar } from "../../ui/SegmentBar.tsx";
import { SidebarHeader } from "../../ui/SidebarHeader.tsx";
import { SidebarRow } from "../../ui/SidebarRow.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { baseName, relativeDate, toDate } from "../shell/format.ts";
import { Page, Section, Sidebar, SplitView } from "../shell/Layout.tsx";
import { ADD_DESTINATION, cleanRequest, resolveIssue } from "../shell/navigation.ts";
import type { ScreenProps } from "../types.ts";
import styles from "./HomeScreen.module.css";
import {
  actionText,
  activityIcon,
  activityText,
  backupNowBlocker,
  detailText,
  figureText,
  hubTitle,
  issueText,
  issueTone,
  MODULE_ICONS,
  moduleColor,
  toneBadge,
} from "./hubText.ts";

export function HomeScreen({ navigate }: ScreenProps) {
  const snapshot = useSnapshot();
  const api = useApi();
  const [checkPending, setCheckPending] = useState(false);
  if (!snapshot) return <div data-testid="screen-home" />;

  // « Tout vérifier » = analyse + git + joignabilité, suivi par le main (`hub.checking`).
  const checking = checkPending || snapshot.hub.checking;
  const startCheck = async () => {
    setCheckPending(true);
    try {
      await api.checkAll();
    } finally {
      setCheckPending(false);
    }
  };
  const stopCheck = async () => {
    await api.cancelCheckAll();
  };

  const top = snapshot.hub.topIssue;
  const footer = top ? (
    <Banner
      tone={issueTone(top)}
      action={
        <Button variant="primary" onClick={() => navigate(resolveIssue(top, snapshot))}>
          {t("hub.resolve")}
        </Button>
      }
    >
      {issueText(top)}
    </Banner>
  ) : undefined;

  return (
    <div data-testid="screen-home" className={styles.root}>
      <SplitView sidebar={<HomeSidebar snapshot={snapshot} navigate={navigate} />}>
        <Page width={1080} footer={footer}>
          <HubHeader
            snapshot={snapshot}
            checking={checking}
            onCheck={() => void startCheck()}
            onStop={() => void stopCheck()}
          />
          <div className={styles.cardsWrap}>
            <div className={styles.cards}>
              {snapshot.hub.modules.map((m) => (
                <ModuleCard key={m.module} state={m} snapshot={snapshot} api={api} navigate={navigate} />
              ))}
            </div>
          </div>
          <Section heading={t("hub.activity.title")}>
            <Activity snapshot={snapshot} />
          </Section>
        </Page>
      </SplitView>
    </div>
  );
}

// MARK: Barre latérale

function destinationDot(d: DestinationView): string {
  if (d.reachable === null && !d.run.lastSuccess) return "var(--status-unknown)";
  if (d.health === "error") return "var(--status-error)";
  if (d.health === "attention" || d.waiting) return "var(--status-attention)";
  return "var(--status-ok)";
}

function destinationMeta(d: DestinationView): string {
  if (d.waiting) return t("home.destination.unreachable");
  if (d.run.lastError) return t("home.destination.failed");
  if (d.run.lastSuccess) return relativeDate(d.run.lastSuccess);
  return t("home.destination.never");
}

function HomeSidebar({ snapshot, navigate }: { snapshot: AppSnapshot; navigate: (r: NavigationRequest) => void }) {
  const { analysis, config, destinations, backup } = snapshot;
  const scanned = new Map(analysis.folders.map((f) => [f.folder, f]));
  const folders =
    analysis.folders.length > 0
      ? analysis.folders.map((f) => ({ path: f.folder, available: f.available, size: f.root?.size ?? null }))
      : config.config.folders.map((f) => ({
          path: f.path,
          available: scanned.get(f.path)?.available ?? true,
          size: null,
        }));
  const total = folders.reduce((n, f) => n + (f.size ?? 0), 0);
  const projects = [...analysis.projects].sort((a, b) => b.size - a.size).slice(0, 6);
  return (
    <Sidebar heading={t("section.home")} label={t("section.home")}>
      <SidebarHeader label={t("sidebar.folders")} />
      {folders.map((f) => (
        <SidebarRow
          key={f.path}
          icon={f.available ? FolderOpen : FolderX}
          label={baseName(f.path)}
          meta={!f.available ? t("home.folder.unavailable") : f.size !== null ? Fmt.bytes(f.size) : undefined}
          onClick={() => navigate({ route: "explorer", ref: f.path })}
        />
      ))}
      {folders.length > 1 && total > 0 && <SidebarRow label={t("sidebar.total")} meta={Fmt.bytes(total)} />}
      {folders.length === 0 && (
        <SidebarRow icon={Plus} label={t("sidebar.add_folder")} onClick={() => navigate({ route: "settings" })} />
      )}

      <SidebarHeader label={t("sidebar.destinations")} />
      {destinations.map((d) => (
        <SidebarRow
          key={d.id}
          dot={destinationDot(d)}
          label={d.label}
          meta={destinationMeta(d)}
          busy={backup.running && backup.destinations.some((p) => p.destination === d.id && !p.result)}
          onClick={() => navigate({ route: "backup", ref: d.id })}
        />
      ))}
      {destinations.length === 0 && (
        <SidebarRow icon={Plus} label={t("sidebar.add_destination")} onClick={() => navigate(ADD_DESTINATION)} />
      )}

      {projects.length > 0 && (
        <>
          <SidebarHeader label={t("sidebar.heaviest")} />
          {projects.map((p) => (
            <SidebarRow
              key={p.path}
              label={p.name}
              meta={Fmt.bytes(p.size)}
              onClick={() => navigate({ route: "explorer", ref: p.path })}
            />
          ))}
        </>
      )}
    </Sidebar>
  );
}

// MARK: En-tête

function HubHeader({
  snapshot,
  checking,
  onCheck,
  onStop,
}: {
  snapshot: AppSnapshot;
  checking: boolean;
  onCheck: () => void;
  onStop: () => void;
}) {
  const { hub } = snapshot;
  const icon = hub.overall === "ok" ? CircleCheck : hub.overall === "attention" ? TriangleAlert : OctagonX;
  const shown = hub.causes.slice(0, 3);
  const more = hub.causes.length - shown.length;
  const checked = hub.lastCheck;
  return (
    <section className={styles.header} aria-labelledby="hub-title">
      <span className={styles.statusCircle} data-level={hub.overall}>
        <Icon icon={icon} size={34} />
      </span>
      <div className={styles.headerText}>
        <h1 id="hub-title" className={styles.title}>
          {hubTitle(hub)}
        </h1>
        {shown.length > 0 && (
          <ul className={styles.causes}>
            {shown.map((c) => (
              <li key={`${c.kind}-${c.ref ?? c.subject}`}>{issueText(c)}</li>
            ))}
            {more > 0 && <li className={styles.more}>{t("hub.more_causes", more)}</li>}
          </ul>
        )}
        <p className={styles.checked}>{checked ? t("hub.checked", relativeDate(checked)) : t("hub.never_checked")}</p>
      </div>
      <div className={styles.headerActions}>
        {checking ? (
          <>
            <span className={styles.checking}>
              <Spinner size="small" />
              {t("hub.checking")}
            </span>
            <Button onClick={onStop}>{t("action.stop")}</Button>
          </>
        ) : (
          <Button variant="primary" icon={ShieldCheck} help={t("hub.check.help")} onClick={onCheck}>
            {t("hub.check")}
          </Button>
        )}
      </div>
    </section>
  );
}

// MARK: Cartes de module

function moduleBusy(m: HubModule, s: AppSnapshot): boolean {
  switch (m) {
    case "storage":
      return s.analysis.running;
    case "backup":
      return s.backup.running;
    case "git":
      return s.git.running;
    case "ai":
      return s.ai.status === "loading";
    case "restore":
      return false;
  }
}

function runAction(action: HubAction, s: AppSnapshot, api: CairnApi, navigate: (r: NavigationRequest) => void) {
  switch (action) {
    case "clean":
      return navigate(cleanRequest(s));
    case "analyze":
      if (!s.analysis.running) void api.scan({});
      return navigate({ route: "storage" });
    case "backupNow":
      return void api.startBackup({});
    case "addDestination":
      return navigate(ADD_DESTINATION);
    case "openBackup":
      return navigate({ route: "backup" });
    case "analyzeGit":
      if (!s.git.running) void api.gitAnalyze({});
      return navigate({ route: "git" });
    case "openGit":
      return navigate({ route: "git" });
    case "viewAI":
      return navigate({ route: "ai" });
    case "restore":
      return navigate({ route: "restore" });
  }
}

function ModuleCard({
  state,
  snapshot,
  api,
  navigate,
}: {
  state: ModuleState;
  snapshot: AppSnapshot;
  api: CairnApi;
  navigate: (r: NavigationRequest) => void;
}) {
  const m = state.module;
  const busy = moduleBusy(m, snapshot);
  const badge = toneBadge(state.tone);
  const detail = busy && m !== "backup" ? t("hub.progress.running") : detailText(state.detail);
  const failed = state.figure.kind === "failed";
  const reason = state.action === "backupNow" ? backupNowBlocker(snapshot) : undefined;
  const volume = m === "storage" ? snapshot.storage.volumes[0] : undefined;
  return (
    <article
      className={styles.card}
      style={{ "--tint": moduleColor(m) } as CSSProperties}
      data-tint=""
      data-module={m}
      aria-label={t(`hub.module.${m}`)}
    >
      <div className={styles.cardTop}>
        <IconTile icon={MODULE_ICONS[m]} size={56} tint={moduleColor(m)} />
        <span className={styles.cardState}>
          {busy ? <Spinner size="small" /> : badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
        </span>
      </div>
      <div className={styles.cardText}>
        <span className={styles.moduleName}>{t(`hub.module.${m}`)}</span>
        <span className={styles.figure} data-failed={failed || undefined}>
          {figureText(state.figure)}
        </span>
        <span className={styles.detail}>{detail ?? " "}</span>
        {volume && (
          <span className={styles.detail}>
            {t("home.used_of", Fmt.bytes(volume.total - volume.free), Fmt.bytes(volume.total))}
          </span>
        )}
      </div>
      <div className={styles.chart}>
        <ModuleChart module={m} snapshot={snapshot} />
      </div>
      <Button
        variant="outline"
        fullWidth
        disabledReason={reason}
        onClick={() => runAction(state.action, snapshot, api, navigate)}
      >
        {actionText(state.action)}
      </Button>
    </article>
  );
}

/** Mini-graphique de la carte (10 px de haut), aux couleurs du module. */
function ModuleChart({ module, snapshot }: { module: HubModule; snapshot: AppSnapshot }) {
  switch (module) {
    case "storage": {
      // Jauge « X utilisés sur Y » du volume principal ; à défaut, part récupérable de la dernière analyse.
      const volume = snapshot.storage.volumes[0];
      if (volume && volume.total > 0) {
        const used = volume.total - volume.free;
        return (
          <FillBar
            value={used / volume.total}
            color="var(--tint)"
            label={t("home.used_of", Fmt.bytes(used), Fmt.bytes(volume.total))}
          />
        );
      }
      const summary = snapshot.analysis.summary;
      if (!summary || summary.totalBytes <= 0) return <FillBar value={0} label={t("home.chart.reclaimable")} />;
      const reclaimable = Object.values(summary.reclaimableByType).reduce((a, b) => a + b, 0);
      return (
        <FillBar value={reclaimable / summary.totalBytes} color="var(--tint)" label={t("home.chart.reclaimable")} />
      );
    }
    case "backup":
      return <BackupDays days={snapshot.backupDays} />;
    case "git": {
      const branches = snapshot.git.reports.reduce((n, r) => n + r.branches.length, 0);
      const worktrees = snapshot.git.reports.reduce((n, r) => n + r.worktrees.length, 0);
      return (
        <SegmentBar
          label={t("home.chart.git", branches, worktrees)}
          parts={[
            { key: "branches", value: branches, color: "var(--tint)" },
            { key: "worktrees", value: worktrees, color: "var(--tint-muted)" },
          ]}
        />
      );
    }
    case "ai": {
      const tools = snapshot.ai.tools.filter((x) => x.detected).sort((a, b) => b.totalBytes - a.totalBytes);
      const colors = ["var(--tint)", "var(--tint-muted)", "var(--tint-active)", "var(--tint-tile)"];
      return (
        <SegmentBar
          label={t("home.chart.ai")}
          parts={tools.map((x, i) => ({ key: x.id, value: x.totalBytes, color: colors[Math.min(i, 3)]! }))}
        />
      );
    }
    case "restore":
      return null;
  }
}

/** Sept pastilles, du plus ancien à aujourd'hui : réussi (couleur du module), échec (rouge), rien (gris). */
function BackupDays({ days }: { days: (boolean | null)[] }) {
  const ok = days.filter((d) => d === true).length;
  return (
    <div className={styles.days} role="img" aria-label={t("home.chart.days", ok)}>
      {days.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sept jours fixes, dans l'ordre.
        <span key={i} className={styles.day} data-state={d === null ? "none" : d ? "ok" : "failed"} />
      ))}
    </div>
  );
}

// MARK: Activité

function Activity({ snapshot }: { snapshot: AppSnapshot }) {
  const labels = Object.fromEntries(snapshot.destinations.map((d) => [d.id, d.label]));
  const events = [...snapshot.activity]
    .sort((a, b) => toDate(b.date).getTime() - toDate(a.date).getTime())
    .slice(0, 10);
  if (events.length === 0) {
    return (
      <Card>
        <p className={styles.empty}>{t("hub.activity.empty")}</p>
      </Card>
    );
  }
  return (
    <Card flush>
      <ul className={styles.activity}>
        {events.map((e) => (
          <li
            key={`${e.kind}-${e.date}-${e.subject ?? ""}-${e.count ?? ""}`}
            className={styles.event}
            data-kind={e.kind}
          >
            <span className={styles.eventIcon}>
              <Icon icon={activityIcon(e.kind)} size={16} />
            </span>
            <span className={styles.eventText}>{activityText(e, labels)}</span>
            <span className={styles.eventDate}>{relativeDate(e.date)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
