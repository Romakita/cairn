// Page d'une destination : en-tête (« … », « Modifier », action principale), bandeaux, progression ou résultat,
// vérification d'intégrité, chiffres clés, historique, rétention et planification. Chaque action indisponible est
// désactivée avec la raison donnée par le main (`unavailable`).
import {
  CalendarClock,
  Copy,
  FlaskConical,
  HardDrive,
  OctagonX,
  Pencil,
  Play,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { type CSSProperties, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot, DestinationView, NavigationRequest } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { IconTile } from "../../ui/IconTile.tsx";
import { MoreButton } from "../../ui/MoreButton.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { Stat } from "../../ui/Stat.tsx";
import styles from "./DestinationPage.module.css";
import { HistoryCard } from "./HistoryCard.tsx";
import {
  addressOf,
  formatDate,
  homeHasSecrets,
  isActive,
  labelOf,
  reachability,
  reachabilityLabel,
  resultFor,
  toDate,
} from "./model.ts";
import { ProgressCard } from "./ProgressCard.tsx";
import { ResultCard } from "./ResultCard.tsx";
import { RetentionCard } from "./RetentionCard.tsx";

export interface DestinationPageProps {
  snapshot: AppSnapshot;
  destination: DestinationView;
  onEdit: () => void;
  onRemove: () => void;
  navigate: (request: NavigationRequest) => void;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function VerificationCard({ snapshot, onClose }: { snapshot: AppSnapshot; onClose: () => void }) {
  const v = snapshot.verification;
  if (!v) return null;
  const damaged = v.reports.reduce((n, r) => n + r.damaged, 0);
  return (
    <Card label={v.full ? t("backup.verify_full.title") : t("backup.verify")}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{v.full ? t("backup.verify_full.title") : t("backup.verify")}</h3>
        <span className={styles.spacer} />
        {!v.running && <IconButton icon={X} label={t("action.close")} onClick={onClose} />}
      </div>
      {v.running && (
        <p className={styles.line}>
          <Spinner size="small" />
          {v.full ? t("backup.verify_full.running") : t("backup.ui.verify.running")}
          {v.total > 0 && (
            <span className={styles.figure}>{t("backup.ui.verify.count", Fmt.count(v.done), Fmt.count(v.total))}</span>
          )}
        </p>
      )}
      {v.error && <Banner tone="danger">{v.error}</Banner>}
      {v.reports.length > 0 && (
        <ul className={styles.reports}>
          {v.reports.map((r) => (
            <li key={r.version} className={styles.report}>
              <span
                className={styles.dot}
                style={{ "--dot": r.damaged > 0 ? "var(--status-error)" : "var(--status-ok)" } as CSSProperties}
              />
              <span className={styles.mono}>{r.version}</span>
              <span className={styles.reportText}>
                {r.missingChecksums ? t("backup.verify_full.pending") : t("backup.ui.verify.result", r.damaged)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!v.running && !v.error && v.reports.length > 0 && (
        <p className={styles.caption}>{t("backup.verify_full.summary", v.reports.length, damaged)}</p>
      )}
    </Card>
  );
}

function scheduleText(snapshot: AppSnapshot): string {
  const s = snapshot.config.config.schedule;
  if (s.frequency === "manual") return t("backup.ui.schedule.manual");
  if (s.frequency === "weekly") return t("backup.ui.schedule.weekly", t(`weekday.${s.weekday}`), s.time);
  return t("backup.ui.schedule.daily", s.time);
}

export function DestinationPage({ snapshot, destination: d, onEdit, onRemove, navigate }: DestinationPageProps) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [verificationClosed, setVerificationClosed] = useState<object | null>(null);
  const call = (run: () => Promise<unknown>) => {
    setError(null);
    run().catch((e) => setError(errorText(e)));
  };

  const backup = snapshot.backup;
  const progress = backup.destinations.find((p) => p.destination === d.id);
  const backingUp = backup.running && progress !== undefined && isActive(progress);
  const stopping = backup.stopping.includes(d.id);
  const reason = (key: string | null) => (key ? t(key) : undefined);
  const runningReason = backup.running ? t("backup.unavailable.running") : undefined;
  const r = reachability(d);
  const run = d.run;

  // Progression : toutes les destinations de l'exécution en cours, celle de la page d'abord.
  const cards = backup.running
    ? [...backup.destinations].sort((a, b) => Number(b.destination === d.id) - Number(a.destination === d.id))
    : [];
  const copyingTo = backup.destinations.find((p) => p.phase === "copying" || p.phase === "counting");
  const result = backup.running ? null : resultFor(snapshot, d.id);
  const resultKey = result ? `${d.id}:${backup.finishedAt ?? ""}` : null;
  const others = backup.running
    ? backup.destinations
        .filter((p) => p.destination !== d.id && isActive(p))
        .map((p) => labelOf(snapshot, p.destination))
    : [];

  const lastSuccess = toDate(run.lastSuccess);
  const lastFailure = toDate(run.lastFailure);
  const failedLast = lastFailure !== null && (lastSuccess === null || lastFailure > lastSuccess);
  const waitingSince = formatDate(run.waitingSince);
  const damagedVersions = run.damagedVersions.length;
  const showVerification = snapshot.verification?.destination === d.id && verificationClosed !== snapshot.verification;

  const unencryptedSecrets = !d.config.encrypted && homeHasSecrets(snapshot.config.config.home.include);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <IconTile icon={d.provider === "smb" ? Server : HardDrive} size={48} />
        <div className={styles.identity}>
          <div className={styles.nameLine}>
            <h1 className={styles.name}>{d.label}</h1>
            <Badge tone={r === "reachable" ? "success" : r === "waiting" ? "warning" : "neutral"}>
              {reachabilityLabel(r)}
            </Badge>
            <Badge tone={d.config.encrypted ? "neutral" : "warning"}>
              {d.config.encrypted ? t("backup.ui.badge.encrypted") : t("backup.ui.badge.not_encrypted")}
            </Badge>
          </div>
          <span className={styles.address}>{addressOf(d)}</span>
        </div>
        <div className={styles.actions}>
          <MoreButton
            label={t("destination.more")}
            entries={[
              {
                id: "simulate",
                label: t("backup.simulate"),
                icon: FlaskConical,
                disabledReason: reason(d.unavailable.simulate),
                onSelect: () => call(() => api.startBackup({ destinations: [d.id], dryRun: true })),
              },
              {
                id: "copy",
                label: t("destination.copy_address"),
                icon: Copy,
                onSelect: () => call(() => api.copyText({ text: addressOf(d) })),
              },
              { kind: "separator" },
              {
                id: "delete",
                label: t("destination.delete.menu"),
                icon: Trash2,
                destructive: true,
                disabledReason: runningReason,
                onSelect: onRemove,
              },
            ]}
          />
          <Button
            icon={Pencil}
            onClick={onEdit}
            disabledReason={backingUp ? t("backup.unavailable.running") : undefined}
          >
            {t("destination.edit")}
          </Button>
          {backingUp ? (
            <Button
              variant="primary"
              icon={OctagonX}
              disabledReason={stopping ? t("action.stopping") : undefined}
              onClick={() => call(() => api.stopBackup({ destination: d.id }))}
            >
              {stopping ? t("action.stopping") : t("action.stop")}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={Play}
              disabledReason={reason(d.unavailable.backup)}
              onClick={() => call(() => api.startBackup({ destinations: [d.id] }))}
            >
              {t("action.backup_now")}
            </Button>
          )}
        </div>
      </header>

      {error && <Banner tone="danger">{error}</Banner>}
      {snapshot.lock.byOther && <Banner tone="info">{t("backup.busy_other")}</Banner>}
      {others.length > 0 && !backingUp && <Banner tone="info">{t("backup.busy_running", others.join(", "))}</Banner>}
      {unencryptedSecrets && <Banner tone="warning">{t("onboarding.destination.unencrypted_warning")}</Banner>}
      {!backup.running && backup.lastError && (
        <Banner
          tone="danger"
          action={
            backup.log ? (
              <Button
                variant="outline"
                onClick={() => call(() => api.openTarget({ kind: "log", file: backup.log ?? "" }))}
              >
                {t("backup.view_log")}
              </Button>
            ) : undefined
          }
        >
          {backup.lastError}
        </Banner>
      )}

      {cards.map((p) =>
        p.result ? (
          <ResultCard
            key={p.destination}
            result={{ destination: p.destination, dryRun: p.dryRun, ...p.result }}
            label={labelOf(snapshot, p.destination)}
          />
        ) : (
          <ProgressCard
            key={p.destination}
            progress={p}
            label={labelOf(snapshot, p.destination)}
            copyingTo={
              copyingTo && copyingTo.destination !== p.destination ? labelOf(snapshot, copyingTo.destination) : null
            }
          />
        ),
      )}
      {result && resultKey !== dismissed && (
        <ResultCard result={result} label={d.label} onDismiss={() => setDismissed(resultKey)} />
      )}
      {showVerification && (
        <VerificationCard snapshot={snapshot} onClose={() => setVerificationClosed(snapshot.verification)} />
      )}

      <div className={styles.stats}>
        <Card fill label={t("backup.ui.stat.last")}>
          <Stat
            label={t("backup.ui.stat.last")}
            value={formatDate(lastSuccess) ?? t("backup.ui.never")}
            detail={
              failedLast && run.lastError
                ? t("backup.ui.stat.failed", formatDate(lastFailure) ?? "")
                : lastSuccess && run.lastDuration > 0
                  ? t("backup.transferred", Fmt.bytes(run.lastBytesTransferred), Fmt.duration(run.lastDuration))
                  : undefined
            }
          />
          {failedLast && run.lastError && <p className={styles.errorText}>{run.lastError}</p>}
        </Card>
        <Card fill label={t("backup.next")}>
          <Stat
            label={t("backup.next")}
            value={d.nextBackup !== null ? (formatDate(d.nextBackup) ?? "") : t("frequency.manual")}
            detail={waitingSince ? t("backup.waiting_since", waitingSince) : scheduleText(snapshot)}
          />
        </Card>
        <Card fill label={t("backup.integrity")}>
          <Stat
            label={t("backup.integrity")}
            value={damagedVersions > 0 ? t("backup.integrity.damaged", damagedVersions) : t("backup.integrity.ok")}
            detail={
              run.lastVerification
                ? t("backup.integrity.checked", formatDate(run.lastVerification) ?? "")
                : t("backup.integrity.never")
            }
          />
          <div className={styles.statActions}>
            <Button
              icon={ShieldCheck}
              disabledReason={reason(d.unavailable.verify)}
              help={t("backup.ui.verify.help")}
              onClick={() => call(() => api.verify({ destination: d.id }))}
            >
              {t("backup.verify")}
            </Button>
            <Button
              disabledReason={reason(d.unavailable.verifyFull)}
              help={t("backup.ui.verify_full.help")}
              onClick={() => call(() => api.verify({ destination: d.id, full: true }))}
            >
              {t("backup.verify_full")}
            </Button>
          </div>
        </Card>
      </div>

      <div className={styles.columns}>
        <div className={styles.wide}>
          <HistoryCard
            destination={d}
            backingUp={backingUp}
            onRefresh={() => call(() => api.refreshHistory({ destination: d.id }))}
          />
        </div>
        <div className={styles.side}>
          <RetentionCard destination={d} disabledReason={runningReason} />
          <Card label={t("backup.ui.schedule.title")}>
            <div className={styles.schedule}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>{t("backup.ui.schedule.title")}</h3>
              </div>
              <p className={styles.line}>
                <span className={styles.lineIcon}>
                  <Icon icon={CalendarClock} size={15} />
                </span>
                {scheduleText(snapshot)}
              </p>
              <p className={styles.caption}>{t("backup.never_wakes")}</p>
              <div>
                <Button variant="outline" onClick={() => navigate({ route: "settings" })}>
                  {t("backup.ui.schedule.change")}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
