// Cadre de l'app (§3.0 de parity/ui.md) : barre du haut compacte (feux tricolores, logo, état global, mise à jour),
// rail des sections, corps flottant arrondi avec l'écran actif et les messages. Assistant plein écran au premier
// lancement. La route suit l'URL (`#/app/<route>`) et les demandes du main (`useNavigation`).
import { useCallback, useEffect, useState } from "react";
import { currentLanguage, setLanguage, t } from "../../../core/l10n.ts";
import type { NavigationRequest, Route } from "../../../shared/contract.ts";
import { useApi, useNavigation, useSnapshot } from "../../api/hooks.ts";
import { MessageBar } from "../../ui/MessageBar.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { AIScreen } from "../ai/AIScreen.tsx";
import { BackupScreen } from "../backup/BackupScreen.tsx";
import { GitScreen } from "../git/GitScreen.tsx";
import { HomeScreen } from "../home/HomeScreen.tsx";
import { OnboardingScreen } from "../onboarding/OnboardingScreen.tsx";
import { RestoreScreen } from "../restore/RestoreScreen.tsx";
import { SettingsScreen } from "../settings/SettingsScreen.tsx";
import { StorageScreen } from "../storage/StorageScreen.tsx";
import { ToolsScreen } from "../tools/ToolsScreen.tsx";
import type { ScreenProps } from "../types.ts";
import { Rail } from "./Rail.tsx";
import styles from "./Shell.module.css";
import { TopBar } from "./TopBar.tsx";

/** Écran de chaque route ; `storage`, `clean` et `explorer` sont les onglets du même écran. */
export function screenFor(props: ScreenProps) {
  switch (props.route) {
    case "home":
      return <HomeScreen {...props} />;
    case "storage":
    case "clean":
    case "explorer":
      return <StorageScreen {...props} />;
    case "backup":
      return <BackupScreen {...props} />;
    case "restore":
      return <RestoreScreen {...props} />;
    case "git":
      return <GitScreen {...props} />;
    case "tools":
      return <ToolsScreen {...props} />;
    case "ai":
      return <AIScreen {...props} />;
    case "settings":
      return <SettingsScreen {...props} />;
    case "onboarding":
      return <OnboardingScreen {...props} />;
  }
}

const ROUTES: readonly Route[] = [
  "home",
  "storage",
  "clean",
  "explorer",
  "backup",
  "restore",
  "git",
  "tools",
  "ai",
  "settings",
  "onboarding",
];

/** Route initiale lue dans l'URL (`#/app/<route>[/<ref>]`) : captures d'écran et liens directs. Sinon l'accueil. */
export function initialRequest(hash: string): NavigationRequest {
  const m = /^#\/app\/([a-z]+)(?:\/([^?#]+))?/.exec(hash);
  const route = m?.[1] as Route | undefined;
  if (!route || !ROUTES.includes(route)) return { route: "home" };
  return m?.[2] ? { route, ref: decodeURIComponent(m[2]) } : { route };
}

function hashFor(request: NavigationRequest): string {
  return `#/app/${request.route}${request.ref ? `/${encodeURIComponent(request.ref)}` : ""}`;
}

export function Shell() {
  const snapshot = useSnapshot();
  const api = useApi();
  const [request, setRequest] = useState<NavigationRequest>(() => initialRequest(location.hash));
  const navigate = useCallback((next: NavigationRequest) => {
    setRequest(next);
    history.replaceState(null, "", hashFor(next));
  }, []);
  useNavigation(navigate);

  // ⌘, : Réglages.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === ",") {
        event.preventDefault();
        navigate({ route: "settings" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // Langue du main : tout est reconstruit quand elle change.
  if (snapshot && snapshot.language !== currentLanguage()) setLanguage(snapshot.language);
  if (snapshot) document.documentElement.lang = snapshot.language;

  if (!snapshot) {
    return (
      <div className={styles.loading} data-testid="shell">
        <Spinner size="regular" label={t("shell.loading")} />
      </div>
    );
  }

  // Premier lancement : l'assistant occupe toute la fenêtre, sauf si l'utilisateur a choisi un autre écran
  // (« Restaurer une sauvegarde plutôt »).
  const onboarding = request.route === "onboarding" || (snapshot.firstLaunch && request.route === "home");
  if (onboarding) {
    return (
      <div className={styles.onboarding} data-testid="shell" key={snapshot.language}>
        <OnboardingScreen route="onboarding" request={request} navigate={navigate} />
      </div>
    );
  }

  const messages = snapshot.messages.slice(-3);
  return (
    <div className={styles.frame} data-testid="shell" key={snapshot.language}>
      <TopBar snapshot={snapshot} navigate={navigate} />
      <Rail route={request.route} navigate={navigate} />
      <div className={styles.body}>
        <div className={styles.screen} data-route={request.route}>
          {screenFor({ route: request.route, request, navigate })}
        </div>
        {messages.length > 0 && (
          <div className={styles.messages}>
            {messages.map((m) => (
              <MessageBar
                key={m.id}
                level={m.level}
                closeLabel={t("action.close")}
                onClose={() => void api.dismissMessage({ id: m.id })}
              >
                {m.text}
              </MessageBar>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
