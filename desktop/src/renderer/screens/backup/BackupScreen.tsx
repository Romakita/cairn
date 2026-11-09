// Écran Sauvegardes (U §3.3, tâches 12.4 et 12.5) : sidebar des destinations, page de la destination choisie,
// feuilles Ajouter / Modifier / Supprimer et mot de passe d'une image neuve. `ref` de la navigation : identifiant
// d'une destination, ou `add` pour ouvrir le formulaire d'ajout (lien « Ajouter une destination » de l'accueil).
import { CloudUpload, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../../core/l10n.ts";
import type { SavedDestinationView } from "../../../shared/contract.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { FullDiskAccessBanner } from "../shell/FullDiskAccessBanner.tsx";
import { SplitView } from "../shell/Layout.tsx";
import type { ScreenProps } from "../types.ts";
import styles from "./BackupScreen.module.css";
import { BackupSidebar } from "./BackupSidebar.tsx";
import { DestinationPage } from "./DestinationPage.tsx";
import { DestinationSheet, type DestinationSheetMode } from "./DestinationSheet.tsx";
import { ImagePasswordSheet } from "./ImagePasswordSheet.tsx";
import { labelOf } from "./model.ts";
import { RemoveSheet } from "./RemoveSheet.tsx";

type SheetState = DestinationSheetMode | { kind: "remove"; id: string } | null;

export function BackupScreen({ request, navigate }: ScreenProps) {
  const snapshot = useSnapshot();
  const api = useApi();
  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [keychainError, setKeychainError] = useState<string | null>(null);

  // Navigation : `add` ouvre le formulaire d'ajout, un identifiant choisit la destination.
  useEffect(() => {
    if (!request?.ref) return;
    if (request.ref === "add") setSheet({ kind: "add" });
    else setSelected(request.ref);
  }, [request]);

  const destinations = snapshot?.destinations ?? [];
  const destination = destinations.find((d) => d.id === selected) ?? destinations[0] ?? null;

  // Historique lu seul à l'ouverture de la page (et quand la destination redevient joignable), sans boucle.
  const loaded = useRef(new Set<string>());
  const historyKey = destination ? `${destination.id}:${String(destination.reachable)}` : null;
  const historyStatus = destination?.history.status;
  useEffect(() => {
    if (!destination || historyKey === null || loaded.current.has(historyKey)) return;
    if (historyStatus === "loading" || destination.reachable === false) return;
    if (historyStatus === "loaded" && destination.history.loadedAt !== null) {
      loaded.current.add(historyKey);
      return;
    }
    loaded.current.add(historyKey);
    void api.refreshHistory({ destination: destination.id }).catch(() => {});
  }, [api, destination, historyKey, historyStatus]);

  if (!snapshot) return <div className={styles.loading} data-testid="screen-backup" />;

  const saved = (s: SavedDestinationView) => {
    setSheet(null);
    setSelected(s.destination.id);
    if (s.keychainError) setKeychainError(s.keychainError);
  };
  const editing = sheet?.kind === "edit" ? sheet : null;
  const removing = sheet?.kind === "remove" ? destinations.find((d) => d.id === sheet.id) : undefined;
  const password = snapshot.backup.newImagePasswords[0];

  return (
    <div className={styles.root} data-testid="screen-backup">
      <SplitView
        sidebar={
          <BackupSidebar
            snapshot={snapshot}
            selected={destination?.id ?? null}
            onSelect={setSelected}
            onAdd={() => setSheet({ kind: "add" })}
            navigate={navigate}
          />
        }
      >
        <div className={styles.scroll}>
          {snapshot.access.fullDisk === "denied" && (
            <div className={styles.notice}>
              <FullDiskAccessBanner snapshot={snapshot} />
            </div>
          )}
          {keychainError && (
            <div className={styles.notice}>
              <Banner
                tone="warning"
                action={
                  <Button variant="outline" onClick={() => setKeychainError(null)}>
                    {t("action.close")}
                  </Button>
                }
              >
                {keychainError}
              </Banner>
            </div>
          )}
          {destination ? (
            <DestinationPage
              key={destination.id}
              snapshot={snapshot}
              destination={destination}
              onEdit={() => setSheet({ kind: "edit", destination })}
              onRemove={() => setSheet({ kind: "remove", id: destination.id })}
              navigate={navigate}
            />
          ) : (
            <div className={styles.empty}>
              <span className={styles.emptyIcon}>
                <Icon icon={CloudUpload} size={39} />
              </span>
              <h1 className={styles.emptyTitle}>{t("backup.ui.empty.title")}</h1>
              <p className={styles.emptyText}>{t("backup.no_destination")}</p>
              <Button variant="primary" icon={Plus} onClick={() => setSheet({ kind: "add" })}>
                {t("sidebar.add_destination")}
              </Button>
            </div>
          )}
        </div>
      </SplitView>

      {(sheet?.kind === "add" || editing) && (
        <DestinationSheet
          mode={editing ?? { kind: "add" }}
          onClose={() => setSheet(null)}
          onSaved={saved}
          navigate={navigate}
        />
      )}
      {removing && (
        <RemoveSheet
          destination={removing}
          busyReason={
            snapshot.backup.running
              ? t("backup.unavailable.running")
              : snapshot.verification?.running
                ? t("backup.unavailable.verifying")
                : undefined
          }
          onClose={() => setSheet(null)}
          onRemoved={() => {
            setSheet(null);
            setSelected(null);
          }}
        />
      )}
      {password && (
        <ImagePasswordSheet
          destination={password.destination}
          label={labelOf(snapshot, password.destination)}
          password={password.password}
        />
      )}
    </div>
  );
}
