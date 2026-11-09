// Carte de progression d'une destination (spec `backup` modifiée) : phase en cours parmi préparation, comptage, copie,
// finalisation, terminé ; compteurs visibles pendant tout le comptage ; copie « dossier n sur N » ; étapes de la
// finalisation ; puis le résultat (version, fichiers et octets transférés, avertissements, journal).
import { Check, Circle, Cpu, FileUp, FolderSearch } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import type { DestinationProgress, FinishStepProgress } from "../../../core/backup/progress.ts";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import { Icon } from "../../ui/Icon.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import { ProgressBar } from "../../ui/ProgressBar.tsx";
import { ProgressRing } from "../../ui/SidebarRow.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { WorkerRow } from "../../ui/WorkerRow.tsx";
import {
  copyRowDetail,
  copyRowLabel,
  copySummary,
  counterLabel,
  countingLine,
  finishStepLabel,
  partLine,
  phaseStates,
  progressFraction,
  progressTitle,
  SHOWN_PHASES,
} from "./model.ts";
import styles from "./ProgressCard.module.css";

/** Heure courante rafraîchie chaque seconde tant que `active` (durée de la liste en cours). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function percentLabel(fraction: number): string {
  return Fmt.percent(fraction, 1, 0);
}

function Ring({ fraction }: { fraction: number | undefined }) {
  return (
    <div className={styles.ring}>
      {fraction === undefined ? (
        <span className={styles.ringTrack} aria-hidden="true" />
      ) : (
        <ProgressRing fraction={fraction} size={84} stroke={8} />
      )}
      <span className={styles.ringCenter}>
        {fraction === undefined ? (
          <Spinner size="large" />
        ) : (
          <span className={styles.ringValue}>{percentLabel(fraction)}</span>
        )}
      </span>
    </div>
  );
}

function Phases({ progress }: { progress: DestinationProgress }) {
  const states = phaseStates(progress);
  return (
    <ol className={styles.phases} aria-label={t("backup.ui.phases")}>
      {SHOWN_PHASES.map((phase, i) => (
        <Fragment key={phase}>
          {i > 0 && <li className={styles.phaseLine} aria-hidden="true" data-state={states[phase]} />}
          <li
            className={styles.phase}
            data-state={states[phase]}
            aria-current={states[phase] === "current" ? "step" : undefined}
          >
            <span className={styles.phaseMark} aria-hidden="true">
              {states[phase] === "done" ? <Icon icon={Check} size={10} /> : null}
            </span>
            {t(`backup.ui.phase.${phase}`)}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function FinishSteps({ steps }: { steps: FinishStepProgress[] }) {
  return (
    <ul className={styles.steps}>
      {steps
        .filter((s) => s.status !== "skipped")
        .map((s) => (
          <li key={s.id} className={styles.step} data-status={s.status}>
            <span className={styles.stepIcon}>
              {s.status === "done" ? (
                <Icon icon={Check} size={14} label={t("backup.worker.done")} />
              ) : s.status === "running" ? (
                <Spinner size="small" />
              ) : (
                <Icon icon={Circle} size={12} />
              )}
            </span>
            <span className={styles.stepText}>
              <span className={styles.stepLabel}>{finishStepLabel(s)}</span>
              {s.status === "running" && s.current && <MiddleText text={s.current} className={styles.mono} />}
            </span>
            {s.status === "running" && s.percent !== null && (
              <span className={styles.stepPercent}>{Fmt.percent(s.percent, 100, 0)}</span>
            )}
          </li>
        ))}
    </ul>
  );
}

export interface ProgressCardProps {
  progress: DestinationProgress;
  /** Nom affiché de la destination. */
  label: string;
  /** Nom de la destination dont la copie est en cours (carte en attente). */
  copyingTo: string | null;
}

/** Carte de progression d'une destination en cours. */
export function ProgressCard({ progress: p, label, copyingTo }: ProgressCardProps) {
  const now = useNow(p.copy?.listing === true);
  const fraction = progressFraction(p);
  const counting = p.counting !== null && !p.counting.done;
  const copying = p.copy !== null && p.finishing === null;
  let summary: string | null = null;
  let detail: string | null = null;
  if (p.phase === "waiting") {
    summary = copyingTo ? t("backup.queued", copyingTo) : t("backup.preparing");
  } else if (p.phase === "preparing") {
    summary = p.preparing ? t(p.preparing.key, ...p.preparing.args) : t("backup.preparing");
  } else if (p.phase === "finishing") {
    summary = p.copy ? t("backup.ui.copied_total", Fmt.count(p.copy.files), Fmt.bytes(p.copy.bytes)) : null;
  } else if (copying) {
    summary = copySummary(p);
    detail = p.copy ? partLine(p.copy) : null;
  }
  return (
    <section className={styles.card} aria-label={t("backup.ui.progress_of", label)} data-phase={p.phase}>
      <div className={styles.top}>
        <Ring fraction={fraction} />
        <div className={styles.main}>
          <div className={styles.titleLine}>
            <h3 className={styles.title}>{progressTitle(p)}</h3>
            <span className={styles.destination}>{label}</span>
          </div>
          <ProgressBar
            value={fraction ?? (p.phase === "waiting" || p.phase === "preparing" ? 0 : undefined)}
            label={progressTitle(p)}
          />
          {summary && <p className={styles.summary}>{summary}</p>}
          {detail && <MiddleText text={detail} className={styles.detail} />}
          {counting && (
            <p className={styles.counting}>
              <Icon icon={FolderSearch} size={14} />
              {countingLine(p)}
            </p>
          )}
          <Phases progress={p} />
        </div>
      </div>
      {copying && p.copy && (
        <div className={styles.workers}>
          <WorkerRow
            icon={FileUp}
            label={copyRowLabel(p.copy)}
            detail={copyRowDetail(p.copy, now)}
            done={false}
            stateLabel={t("backup.ui.in_progress")}
          />
          {counting &&
            (p.counting?.counters ?? []).map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: un compteur par rang, fixe pendant le comptage.
              <Fragment key={i}>
                <div className={styles.divider} />
                <WorkerRow
                  icon={Cpu}
                  label={counterLabel(i, c.folder, c.found)}
                  detail={c.done ? t("backup.worker.done") : c.current || t("backup.ui.listing_short")}
                  done={c.done}
                  stateLabel={c.done ? t("backup.worker.done") : t("backup.ui.in_progress")}
                />
              </Fragment>
            ))}
        </div>
      )}
      {p.phase === "finishing" && p.finishing && (
        <div className={styles.workers}>
          <FinishSteps steps={p.finishing} />
        </div>
      )}
    </section>
  );
}
