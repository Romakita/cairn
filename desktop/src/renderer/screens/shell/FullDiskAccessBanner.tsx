// Bandeau « Accès complet au disque » (spec `backup`, « Accès complet au disque ») : accueil et écran Sauvegardes.
// Sans cet accès, macOS refuse la lecture de Documents, Téléchargements… et la sauvegarde les saute. Le bouton ouvre
// le réglage système (méthode dédiée `openPrivacySettings` du main) ; l'état revient quand l'app repasse au premier
// plan.
import { ShieldAlert } from "lucide-react";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import styles from "./FullDiskAccessBanner.module.css";

/** Rien tant que l'accès n'est pas refusé (accordé ou inconnu). */
export function FullDiskAccessBanner({ snapshot }: { snapshot: AppSnapshot }) {
  const api = useApi();
  if (snapshot.access.fullDisk !== "denied") return null;
  return (
    <Banner
      tone="warning"
      icon={ShieldAlert}
      action={
        <Button variant="outline" onClick={() => void api.openPrivacySettings()}>
          {t("shell.full_disk.open")}
        </Button>
      }
    >
      <div className={styles.text} data-testid="full-disk-access">
        <span>{t("shell.full_disk.text")}</span>
        <span className={styles.help}>{t("shell.full_disk.help")}</span>
      </div>
    </Banner>
  );
}
