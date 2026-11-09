// Rétention d'une destination : brouillon, puis « Enregistrer » → `planRetention`. Si des versions seraient
// supprimées, une feuille les liste avec la taille libérée avant `applyRetention` (le main redemande confirmation).
import { useEffect, useState } from "react";
import type { Retention } from "../../../core/config.ts";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { DestinationView, RetentionPlanView } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { sameRetention } from "./model.ts";
import styles from "./RetentionCard.module.css";
import { RetentionEditor } from "./RetentionEditor.tsx";

const SHOWN_VERSIONS = 10;

export interface RetentionCardProps {
  destination: DestinationView;
  /** Raison pour laquelle la rétention ne peut pas être changée maintenant (sauvegarde en cours). */
  disabledReason?: string;
}

export function RetentionCard({ destination, disabledReason }: RetentionCardProps) {
  const api = useApi();
  const saved = destination.config.retention;
  const [draft, setDraft] = useState<Retention>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RetentionPlanView | null>(null);
  // Autre destination, ou rétention enregistrée : le brouillon repart de la configuration (comparée par valeur, car
  // chaque état poussé par le main est un nouvel objet).
  const savedKey = `${destination.id}:${JSON.stringify(saved)}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `savedKey` résume `saved` et la destination.
  useEffect(() => {
    setDraft(saved);
    setError(null);
  }, [savedKey]);
  const changed = !sameRetention(draft, saved);

  const apply = async (planId: string) => {
    setBusy(true);
    try {
      const r = await api.applyRetention({ planId });
      if (!r.cancelled) setPlan(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.planRetention({ destination: destination.id, retention: draft });
      if (p.decision === "unreachable") setError(t("backup.retention.unreachable"));
      else if (p.decision === "confirm" && p.excess && p.excess.names.length > 0) setPlan(p);
      else await apply(p.planId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const excess = plan?.excess;
  return (
    <Card label={t("backup.retention")}>
      <div className={styles.body}>
        <h3 className={styles.title}>{t("backup.retention")}</h3>
        <RetentionEditor value={draft} onChange={setDraft} />
        {error && <Banner tone="danger">{error}</Banner>}
        {changed && (
          <div className={styles.actions}>
            <Button onClick={() => setDraft(saved)}>{t("action.cancel")}</Button>
            <Button variant="primary" loading={busy} disabledReason={disabledReason} onClick={() => void save()}>
              {t("action.save")}
            </Button>
          </div>
        )}
      </div>
      <Sheet
        open={plan !== null}
        onClose={busy ? undefined : () => setPlan(null)}
        heading={excess ? t("backup.ui.retention.confirm_title", excess.names.length, Fmt.bytes(excess.bytes)) : ""}
        description={t("backup.ui.retention.confirm_text")}
        closeLabel={t("action.close")}
        width={520}
        footer={
          <>
            <Button onClick={() => setPlan(null)}>{t("action.cancel")}</Button>
            <Button variant="danger" loading={busy} onClick={() => plan && void apply(plan.planId)}>
              {excess ? t("backup.ui.retention.delete", excess.names.length) : t("action.delete")}
            </Button>
          </>
        }
      >
        {excess && (
          <ul className={styles.versions}>
            {excess.names.slice(0, SHOWN_VERSIONS).map((n) => (
              <li key={n}>{n}</li>
            ))}
            {excess.names.length > SHOWN_VERSIONS && (
              <li className={styles.more}>{t("confirm.more", excess.names.length - SHOWN_VERSIONS)}</li>
            )}
          </ul>
        )}
        <p className={styles.note}>{t("confirm.irreversible")}</p>
      </Sheet>
    </Card>
  );
}
