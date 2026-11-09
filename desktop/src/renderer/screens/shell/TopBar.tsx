// Barre du haut (38 px) : zone de déplacement de la fenêtre (titleBarStyle hiddenInset, feux tricolores à gauche),
// logo, bouton de mise à jour si une version est disponible, indicateur de l'état global.
import { CircleArrowUp, CircleCheck, OctagonX, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot, NavigationRequest } from "../../../shared/contract.ts";
import { CairnLogo } from "../../ui/CairnLogo.tsx";
import { TitleBarButton } from "../../ui/TitleBarButton.tsx";
import { issueText } from "../home/hubText.ts";
import { statusTarget } from "./navigation.ts";
import styles from "./TopBar.module.css";
import { UpdatePopover } from "./UpdatePopover.tsx";

export function TopBar({
  snapshot,
  navigate,
}: {
  snapshot: AppSnapshot;
  navigate: (request: NavigationRequest) => void;
}) {
  const [updateOpen, setUpdateOpen] = useState(false);
  const updateButton = useRef<HTMLButtonElement>(null);
  const available = snapshot.updates.available;
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <CairnLogo size={20} badge />
        <span className={styles.name}>Cairn</span>
      </div>
      <div className={styles.actions}>
        {available && (
          <>
            <TitleBarButton
              buttonRef={updateButton}
              tone="accent"
              icon={CircleArrowUp}
              text={t("update.available")}
              expanded={updateOpen}
              onClick={() => setUpdateOpen((o) => !o)}
            />
            <UpdatePopover
              open={updateOpen}
              onClose={() => setUpdateOpen(false)}
              anchor={updateButton}
              updates={snapshot.updates}
            />
          </>
        )}
        <StatusIndicator snapshot={snapshot} navigate={navigate} />
      </div>
    </header>
  );
}

/** État global (même règle que l'icône de la barre des menus) ; un clic mène à sa cause. */
function StatusIndicator({
  snapshot,
  navigate,
}: {
  snapshot: AppSnapshot;
  navigate: (request: NavigationRequest) => void;
}) {
  const { hub, backup } = snapshot;
  const top = hub.topIssue;
  const tooltip = top ? issueText(top) : undefined;
  const go = () => navigate(statusTarget(snapshot));
  if (backup.running) {
    const text = t("status.backing_up");
    return <TitleBarButton busy text={text} label={text} onClick={go} />;
  }
  const props =
    hub.overall === "ok"
      ? { tone: "success" as const, icon: CircleCheck, text: t("status.ok") }
      : hub.overall === "attention"
        ? { tone: "warning" as const, icon: TriangleAlert, text: t("status.attention") }
        : { tone: "danger" as const, icon: OctagonX, text: t("status.error") };
  return <TitleBarButton {...props} tooltip={tooltip} onClick={go} />;
}
