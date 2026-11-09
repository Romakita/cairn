// Résultat d'une destination (dernière sauvegarde ou simulation) : état, version, fichiers et octets transférés,
// avertissements, fichiers abîmés, contrôle de l'image, erreur ; bouton du journal.
import { CircleCheck, CircleX, FileText, OctagonPause, X } from "lucide-react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import { partVolumes, type ShownResult } from "./model.ts";
import styles from "./ResultCard.module.css";

const MAX_DAMAGED = 10;

export interface ResultCardProps {
  result: ShownResult;
  label: string;
  onDismiss?: () => void;
}

function statusIcon(status: ShownResult["status"]) {
  if (status === "succeeded") return CircleCheck;
  if (status === "stopped" || status === "waiting") return OctagonPause;
  return CircleX;
}

export function ResultCard({ result: r, label, onDismiss }: ResultCardProps) {
  const api = useApi();
  const snapshot = useSnapshot();
  const parts = r.dryRun
    ? partVolumes(r.bytesByPart, (id) => snapshot?.ai.tools.find((x) => x.id === id)?.name ?? id)
    : [];
  const title = r.dryRun
    ? t("backup.result.simulation")
    : r.status === "succeeded"
      ? t("backup.ui.title.done")
      : r.status === "waiting"
        ? t("backup.ui.title.waiting")
        : r.status === "stopped"
          ? t("backup.ui.title.stopped")
          : t("backup.ui.title.failed");
  const total = r.dryRun
    ? t("backup.ui.result.to_copy", Fmt.bytes(r.bytesTransferred), Fmt.count(r.filesTransferred))
    : t("backup.result.files", Fmt.bytes(r.bytesTransferred), Fmt.count(r.filesTransferred));
  return (
    <section className={styles.card} data-status={r.status} aria-label={title}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Icon icon={statusIcon(r.status)} size={20} />
        </span>
        <div className={styles.heading}>
          <h3 className={styles.title}>{title}</h3>
          <span className={styles.subtitle}>{r.version ? t("backup.ui.result.version", label, r.version) : label}</span>
        </div>
        {r.log && (
          <Button icon={FileText} onClick={() => r.log && void api.openTarget({ kind: "log", file: r.log })}>
            {t("backup.view_log")}
          </Button>
        )}
        {onDismiss && <IconButton icon={X} label={t("action.close")} onClick={onDismiss} />}
      </header>
      {(r.status === "succeeded" || r.dryRun) && (
        <div className={styles.total}>
          <span>{t("backup.result.total", label)}</span>
          <span className={styles.figure}>{total}</span>
        </div>
      )}
      {parts.length > 0 && (
        <ul className={styles.parts} aria-label={t("backup.ui.result.by_part")}>
          {parts.map((p) => (
            <li key={p.key} className={styles.part}>
              <MiddleText text={p.label} className={styles.partName} />
              <span className={styles.figure}>{Fmt.bytes(p.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {r.status === "waiting" && !r.error && (
        <Banner tone="warning">{t("destination.error.unreachable", label)}</Banner>
      )}
      {r.error && (
        <Banner tone={r.status === "waiting" ? "warning" : "danger"}>
          <MiddleText text={r.error} />
        </Banner>
      )}
      {r.warnings.length > 0 && (
        <Banner tone="warning">
          <ul className={styles.list}>
            {r.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}
      {r.damagedFiles.length > 0 && (
        <Banner tone="warning">
          <span>{t("backup.notify.damaged_body", r.damagedFiles.length)}</span>
          <ul className={styles.mono}>
            {r.damagedFiles.slice(0, MAX_DAMAGED).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Banner>
      )}
      {r.imageCheck && !r.imageCheck.ok && (
        <Banner tone="danger">{t("backup.image_check.failed", r.imageCheck.output)}</Banner>
      )}
    </section>
  );
}
