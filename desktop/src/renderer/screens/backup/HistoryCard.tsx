// Historique des versions de ce Mac sur une destination : lu seul à l'ouverture de la page (BackupScreen), chargement,
// liste (12 premières puis « Tout afficher »), vides expliqués (injoignable, sauvegarde en cours, erreur, aucune).
import { RefreshCw } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { t } from "../../../core/l10n.ts";
import type { DestinationView } from "../../../shared/contract.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import styles from "./HistoryCard.module.css";
import { formatDate } from "./model.ts";

const SHOWN = 12;

export interface HistoryCardProps {
  destination: DestinationView;
  /** Une sauvegarde de cette destination est en cours. */
  backingUp: boolean;
  onRefresh: () => void;
}

export function HistoryCard({ destination: d, backingUp, onRefresh }: HistoryCardProps) {
  const [all, setAll] = useState(false);
  const h = d.history;
  const versions = all ? h.versions : h.versions.slice(0, SHOWN);
  const refreshReason =
    h.status === "loading" ? t("backup.history.loading") : backingUp ? t("backup.history.busy") : undefined;
  let empty: string | null = null;
  if (h.status === "loading" && h.versions.length === 0) empty = null;
  else if (backingUp && h.versions.length === 0) empty = t("backup.history.busy");
  else if (h.status === "failed")
    empty = d.reachable === false ? t("backup.history.unreachable") : t("backup.history.error", h.error ?? "");
  else if (h.status === "idle" && d.reachable === false) empty = t("backup.history.unreachable");
  else if (h.status === "loaded" && h.versions.length === 0) empty = t("backup.history.empty");
  return (
    <Card label={t("backup.history")}>
      <div className={styles.header}>
        <h3 className={styles.title}>{t("backup.history")}</h3>
        {h.status === "loaded" && h.versions.length > 0 && (
          <span className={styles.count}>{t("backup.history.count", h.versions.length)}</span>
        )}
        <span className={styles.spacer} />
        {h.status === "loading" && <Spinner size="small" label={t("backup.history.loading")} />}
        <IconButton
          icon={RefreshCw}
          label={t("backup.history.refresh")}
          disabledReason={refreshReason}
          onClick={onRefresh}
        />
      </div>
      {h.status === "loading" && h.versions.length === 0 && (
        <p className={styles.empty}>
          <Spinner size="small" /> {t("backup.history.loading")}
        </p>
      )}
      {empty && (
        <div className={styles.emptyBox}>
          <p className={styles.empty}>{empty}</p>
          {(h.status === "failed" || d.reachable === false) && !backingUp && (
            <Button onClick={onRefresh}>{t("probe.retry")}</Button>
          )}
        </div>
      )}
      {versions.length > 0 && h.status !== "failed" && (
        <ul className={styles.list}>
          {versions.map((v) => (
            <li key={v.name} className={styles.row}>
              <span
                className={styles.dot}
                style={
                  {
                    "--dot": v.damaged
                      ? "var(--status-error)"
                      : v.partial
                        ? "var(--status-attention)"
                        : "var(--status-ok)",
                  } as CSSProperties
                }
              />
              <span className={styles.date}>{formatDate(v.date) ?? v.name}</span>
              {v.damaged && <Badge tone="danger">{t("backup.ui.badge.damaged")}</Badge>}
              {v.partial && <Badge tone="warning">{t("backup.ui.badge.partial")}</Badge>}
              <span className={styles.name}>{v.name}</span>
            </li>
          ))}
        </ul>
      )}
      {h.versions.length > SHOWN && h.status !== "failed" && (
        <div className={styles.more}>
          {!all && <span className={styles.count}>{t("backup.history.more", h.versions.length - SHOWN)}</span>}
          <Button onClick={() => setAll((v) => !v)}>
            {all ? t("backup.ui.history.less") : t("backup.ui.history.all")}
          </Button>
        </div>
      )}
    </Card>
  );
}
