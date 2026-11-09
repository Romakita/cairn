// Cadre de l'app : provisoire, remplacé à la tâche 12.1 (barre du haut, rail, sidebar, navigation).
import { useState } from "react";
import type { NavigationRequest, Route } from "../../../shared/contract.ts";
import { useNavigation } from "../../api/hooks.ts";
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

/** Route initiale lue dans l'URL (`#/app/<route>`) : captures d'écran et liens directs. Sinon l'accueil. */
export function initialRequest(hash: string): NavigationRequest {
  const route = /^#\/app\/([a-z]+)/.exec(hash)?.[1] as Route | undefined;
  return { route: route && ROUTES.includes(route) ? route : "home" };
}

export function Shell() {
  const [request, setRequest] = useState<NavigationRequest>(() => initialRequest(location.hash));
  useNavigation(setRequest);
  return <div data-testid="shell">{screenFor({ route: request.route, request, navigate: setRequest })}</div>;
}
