// Feuille « Supprimer la destination » : garder les sauvegardes (défaut) ou supprimer aussi celles de ce Mac ; aperçu
// de ce qui sera retiré (`planDestinationRemoval`, simulation requise pour supprimer les sauvegardes), puis
// `removeDestination` (le main redemande confirmation). Les mots de passe du Trousseau ne sont jamais supprimés.
import { Archive, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { DestinationView, RemovalPlanView } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { ChoiceTile } from "../../ui/ChoiceTile.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import styles from "./RemoveSheet.module.css";

export interface RemoveSheetProps {
  destination: DestinationView;
  /** Une sauvegarde ou une vérification est en cours : suppression refusée. */
  busyReason?: string;
  onClose: () => void;
  onRemoved: () => void;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function RemoveSheet({ destination: d, busyReason, onClose, onRemoved }: RemoveSheetProps) {
  const api = useApi();
  const [includeBackups, setIncludeBackups] = useState(false);
  const [plan, setPlan] = useState<RemovalPlanView | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const simulate = useCallback(
    async (withBackups: boolean) => {
      setSimulating(true);
      setError(null);
      try {
        setPlan(await api.planDestinationRemoval({ id: d.id, includeBackups: withBackups }));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setSimulating(false);
      }
    },
    [api, d.id],
  );

  // Garder les sauvegardes : l'aperçu se lit tout de suite (rien sur la destination). Les supprimer : « Simuler ».
  useEffect(() => {
    setPlan(null);
    if (!includeBackups) void simulate(false);
  }, [includeBackups, simulate]);

  const remove = async () => {
    if (!plan) return;
    setRemoving(true);
    setError(null);
    try {
      const r = await api.removeDestination({ planId: plan.planId });
      if (!r.cancelled) onRemoved();
    } catch (e) {
      setError(t("destination.delete.error.removal", errorText(e)));
    } finally {
      setRemoving(false);
    }
  };

  const current = plan && plan.includeBackups === includeBackups ? plan : null;
  const confirmReason =
    busyReason ??
    (current === null
      ? includeBackups
        ? t("destination.delete.need_simulation")
        : t("destination.delete.simulating")
      : current.backupsUnavailable
        ? t("destination.delete.error.unavailable", current.backupsUnavailable)
        : !current.canExecute
          ? t("destination.delete.error.unavailable", "")
          : undefined);
  const confirmLabel =
    current && current.backupBytes > 0
      ? t("destination.delete.confirm_all", Fmt.bytes(current.backupBytes))
      : t("destination.delete.confirm");

  return (
    <Sheet
      open
      onClose={removing ? undefined : onClose}
      heading={t("destination.delete.title", d.label)}
      description={t("destination.delete.text")}
      closeLabel={t("action.close")}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          {includeBackups && (
            <Button loading={simulating} onClick={() => void simulate(true)}>
              {t("backup.simulate")}
            </Button>
          )}
          <Button
            variant="danger"
            icon={Trash2}
            loading={removing}
            disabledReason={confirmReason}
            onClick={() => void remove()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.tiles} role="radiogroup" aria-label={t("destination.delete.preview_title")}>
          <ChoiceTile
            icon={Archive}
            label={t("destination.delete.keep")}
            description={t("destination.delete.keep.text")}
            selected={!includeBackups}
            onSelect={() => setIncludeBackups(false)}
          />
          <ChoiceTile
            icon={Trash2}
            label={t("destination.delete.remove")}
            description={t("destination.delete.remove.text")}
            selected={includeBackups}
            onSelect={() => setIncludeBackups(true)}
          />
        </div>

        <section className={styles.preview} aria-label={t("destination.delete.preview_title")}>
          <h3 className={styles.title}>{t("destination.delete.preview_title")}</h3>
          {simulating && (
            <p className={styles.status}>
              <Spinner size="small" />
              {t("destination.delete.simulating")}
            </p>
          )}
          {!simulating && current === null && includeBackups && (
            <p className={styles.status}>{t("destination.delete.need_simulation")}</p>
          )}
          {current && (
            <ul className={styles.items}>
              {current.items.map((item) => (
                <li key={item.kind === "backups" ? item.path : item.kind} className={styles.item}>
                  {item.kind === "configuration" && t("destination.delete.item.config", item.id)}
                  {item.kind === "state" && t("destination.delete.item.state")}
                  {item.kind === "backups" && (
                    <>
                      <span>{t("destination.delete.item.backups", Fmt.bytes(item.bytes))}</span>
                      <span className={styles.mono}>{item.path}</span>
                    </>
                  )}
                </li>
              ))}
              {current.includeBackups &&
                !current.items.some((i) => i.kind === "backups") &&
                !current.backupsUnavailable && <li className={styles.item}>{t("destination.delete.no_backups")}</li>}
            </ul>
          )}
        </section>
        {current?.backupsUnavailable && (
          <Banner tone="danger">{t("destination.delete.error.unavailable", current.backupsUnavailable)}</Banner>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        {busyReason && <Banner tone="info">{busyReason}</Banner>}
        <p className={styles.note}>
          {includeBackups ? t("destination.delete.kept_passwords") : t("destination.delete.kept_note")}
        </p>
        {includeBackups && <p className={styles.danger}>{t("confirm.irreversible")}</p>}
      </div>
    </Sheet>
  );
}
