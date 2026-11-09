// Panneau de la barre des menus (#/menubar, §3.11 ; spec menu-bar) : état global, espace libre, récupérable,
// sauvegardes, analyse ancienne, alertes de disque, actions rapides. Aucune suppression ici : « Nettoyer » ouvre
// l'écran Nettoyable de la fenêtre, avec la présélection, où tout passe par la confirmation habituelle.
import { ChartPie, CloudUpload, House, Power, SlidersHorizontal } from "lucide-react";
import { Fmt } from "../../../core/format.ts";
import { currentLanguage, setLanguage, t } from "../../../core/l10n.ts";
import type { AppSnapshot, CairnApi, NavigationRequest } from "../../../shared/contract.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { CairnLogo } from "../../ui/CairnLogo.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { IconTile } from "../../ui/IconTile.tsx";
import { MoreButton } from "../../ui/MoreButton.tsx";
import { ProgressBar } from "../../ui/ProgressBar.tsx";
import { RingGauge } from "../../ui/RingGauge.tsx";
import { type Segment, SegmentBar } from "../../ui/SegmentBar.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { backupNowBlocker } from "../home/hubText.ts";
import { isToday, relativeDate, timeOfDay, toDate } from "../shell/format.ts";
import styles from "./MenuBarPanel.module.css";

const RECLAIMABLE_TYPES = ["deps", "build", "ios", "python", "cache"] as const;
const CATEGORY_COLOR: Record<(typeof RECLAIMABLE_TYPES)[number], string> = {
  deps: "var(--category-deps)",
  build: "var(--category-build)",
  ios: "var(--category-ios)",
  python: "var(--category-python)",
  cache: "var(--category-cache)",
};

export function MenuBarPanel() {
  const snapshot = useSnapshot();
  const api = useApi();
  if (snapshot && snapshot.language !== currentLanguage()) setLanguage(snapshot.language);
  if (!snapshot) {
    return (
      <div data-testid="menubar-panel" className={styles.panel}>
        <div className={styles.loading}>
          <Spinner size="regular" />
        </div>
      </div>
    );
  }
  /** Ouvre la fenêtre de Cairn sur un écran, puis referme le panneau. */
  const open = (request: NavigationRequest) => {
    void api.openWindow(request).then(() => api.hidePanel());
  };
  return (
    <div data-testid="menubar-panel" className={styles.panel} key={snapshot.language}>
      <Header snapshot={snapshot} open={open} />
      <div className={styles.body}>
        <StorageTile snapshot={snapshot} />
        <BackupTile snapshot={snapshot} />
        <AnalysisTile snapshot={snapshot} api={api} />
        {snapshot.storage.alerts.map((a) => (
          <Banner key={a.volume} tone={a.level === 2 ? "danger" : "warning"}>
            <strong>{t(a.level === 2 ? "alerts.critical_title" : "alerts.low_title", a.volume)}</strong>
            <br />
            {t("alerts.body", Fmt.bytes(a.available), Fmt.number(a.percentFree, 1))}
            {a.daysToFull !== null && ` ${t("alerts.forecast", a.daysToFull)}`}
            <span className={styles.alertAction}>
              <Button variant="outline" onClick={() => void api.snoozeAlert({ volume: a.volume })}>
                {t("menubar.snooze")}
              </Button>
            </span>
          </Banner>
        ))}
      </div>
      <Actions snapshot={snapshot} api={api} open={open} />
    </div>
  );
}

function Header({ snapshot, open }: { snapshot: AppSnapshot; open: (r: NavigationRequest) => void }) {
  const overall = snapshot.hub.overall;
  return (
    <header className={styles.header}>
      <CairnLogo size={22} badge />
      <span className={styles.name}>Cairn</span>
      {snapshot.backup.running ? (
        <Badge tone="info">{t("status.backing_up")}</Badge>
      ) : (
        overall !== "ok" && (
          <Badge tone={overall === "error" ? "danger" : "warning"}>
            {overall === "error" ? t("status.error") : t("status.attention")}
          </Badge>
        )
      )}
      <span className={styles.spacer} />
      <IconButton
        icon={SlidersHorizontal}
        label={t("section.settings")}
        tooltipSide="bottom"
        onClick={() => open({ route: "settings" })}
      />
    </header>
  );
}

function reclaimable(snapshot: AppSnapshot): { total: number; parts: Segment[]; extra: string | null } {
  const summary = snapshot.analysis.summary;
  if (!summary) return { total: 0, parts: [], extra: null };
  const parts = RECLAIMABLE_TYPES.map((k) => ({
    key: k,
    value: summary.reclaimableByType[k] ?? 0,
    color: CATEGORY_COLOR[k],
  }));
  const regenerable = parts.reduce((n, p) => n + p.value, 0);
  const extra =
    summary.obsoleteWorktreeBytes > 0 || summary.trashBytes > 0
      ? t("menu.extra_reclaimable", Fmt.bytes(summary.obsoleteWorktreeBytes), Fmt.bytes(summary.trashBytes))
      : null;
  return { total: regenerable + summary.obsoleteWorktreeBytes + summary.trashBytes, parts, extra };
}

/** Espace libre du volume principal (anneau quand sa part est connue) et espace récupérable. */
function StorageTile({ snapshot }: { snapshot: AppSnapshot }) {
  const free = snapshot.storage.freeBytes;
  const alert = snapshot.storage.alerts[0];
  const color = alert ? (alert.level === 2 ? "var(--status-error)" : "var(--status-attention)") : undefined;
  const r = reclaimable(snapshot);
  const freeText = free !== null ? Fmt.bytes(free) : "–";
  return (
    <section className={styles.tile} aria-label={t("hub.module.storage")}>
      <div className={styles.storage}>
        {alert ? (
          <RingGauge value={1 - alert.percentFree / 100} color={color} label={t("menubar.used_share")}>
            <span className={styles.ringValue}>{freeText}</span>
            <span className={styles.ringLabel}>{t("home.free")}</span>
          </RingGauge>
        ) : (
          <div className={styles.freeBlock}>
            <span className={styles.bigValue}>{freeText}</span>
            <span className={styles.caption}>{t("home.free")}</span>
          </div>
        )}
        <div className={styles.reclaim}>
          <span className={styles.caption}>{t("home.reclaimable")}</span>
          <span className={styles.value}>{Fmt.bytes(r.total)}</span>
          <SegmentBar parts={r.parts} label={t("home.reclaimable")} />
          {r.extra && <span className={styles.small}>{r.extra}</span>}
        </div>
      </div>
    </section>
  );
}

function nextBackupText(snapshot: AppSnapshot): string | null {
  const schedule = snapshot.config.config.schedule;
  if (snapshot.destinations.length === 0) return null;
  if (schedule.frequency === "manual") return t("menu.next_backup_manual");
  const nexts = snapshot.destinations.map((d) => d.nextBackup).filter((n): n is number => n !== null);
  if (nexts.length === 0) return null;
  const next = Math.min(...nexts);
  if (next <= Date.now()) return t("menu.next_backup_due");
  return t("menu.next_backup", isToday(next) ? timeOfDay(next) : Fmt.date(toDate(next)));
}

function BackupTile({ snapshot }: { snapshot: AppSnapshot }) {
  const { destinations, backup } = snapshot;
  const lasts = destinations.map((d) => d.run.lastSuccess).filter((d): d is Date => Boolean(d));
  const last = lasts.length > 0 ? Math.max(...lasts.map((d) => toDate(d).getTime())) : null;
  const waiting = destinations.find((d) => d.waiting);
  const title = backup.running
    ? t("status.backing_up")
    : last !== null
      ? t("menu.backed_up", relativeDate(last))
      : t("home.no_backup");
  const lines = [
    destinations.length === 0 ? t("home.no_destination") : null,
    waiting ? t("menu.waiting", waiting.label) : null,
    nextBackupText(snapshot),
  ].filter((l): l is string => Boolean(l));
  return (
    <section className={styles.tile} aria-label={t("hub.module.backup")}>
      <div className={styles.row}>
        <IconTile icon={CloudUpload} size={34} />
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>{title}</span>
          {backup.running ? (
            <ProgressBar label={t("status.backing_up")} />
          ) : (
            lines.map((l) => (
              <span key={l} className={styles.small}>
                {l}
              </span>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

/** Analyse absente ou de plus de 7 jours : le panneau le dit et propose de la relancer. */
function AnalysisTile({ snapshot, api }: { snapshot: AppSnapshot; api: CairnApi }) {
  const { analysis } = snapshot;
  if (analysis.running) {
    return (
      <section className={styles.tile}>
        <div className={styles.row}>
          <Spinner size="small" />
          <span className={styles.rowTitle}>{t("menubar.analyzing")}</span>
        </div>
      </section>
    );
  }
  if (analysis.summary && !analysis.stale) return null;
  const text = analysis.summary
    ? t("menu.analysis_stale", Fmt.date(toDate(analysis.summary.date)))
    : t("menu.no_analysis");
  return (
    <section className={styles.tile}>
      <div className={styles.row}>
        <IconTile icon={ChartPie} size={34} />
        <span className={styles.rowText}>
          <span className={styles.small}>{text}</span>
        </span>
        <Button onClick={() => void api.scan({})}>{t("action.analyze")}</Button>
      </div>
    </section>
  );
}

function Actions({
  snapshot,
  api,
  open,
}: {
  snapshot: AppSnapshot;
  api: CairnApi;
  open: (r: NavigationRequest) => void;
}) {
  const r = reclaimable(snapshot);
  const analysis = snapshot.analysis;
  const cleanReason =
    analysis.summary === null ? t("menu.no_analysis") : r.total <= 0 ? t("menubar.nothing_to_clean") : undefined;
  const scanReason = analysis.running ? t("menubar.analyzing") : undefined;
  return (
    <footer className={styles.actions}>
      <Button variant="primary" fullWidth disabledReason={cleanReason} onClick={() => open({ route: "clean" })}>
        {t("menu.clean_amount", Fmt.bytes(r.total))}
      </Button>
      <div className={styles.actionRow}>
        <div className={styles.grow}>
          <Button fullWidth disabledReason={backupNowBlocker(snapshot)} onClick={() => void api.startBackup({})}>
            {t("action.backup_now")}
          </Button>
        </div>
        <MoreButton
          label={t("menu.more")}
          entries={[
            {
              id: "analyze",
              label: t("action.analyze"),
              icon: ChartPie,
              disabledReason: scanReason,
              onSelect: () => void api.scan({}),
            },
            { id: "open", label: t("menu.open"), icon: House, onSelect: () => open({ route: "home" }) },
            {
              id: "settings",
              label: t("section.settings"),
              icon: SlidersHorizontal,
              onSelect: () => open({ route: "settings" }),
            },
            { kind: "separator" },
            { id: "quit", label: t("menu.quit"), icon: Power, onSelect: () => void api.quit() },
          ]}
        />
      </div>
      <span className={styles.footnote}>
        {analysis.summary ? t("menu.analysis_date", Fmt.date(toDate(analysis.summary.date))) : t("menu.no_analysis")}
      </span>
    </footer>
  );
}
