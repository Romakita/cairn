// Confirmations des actions destructives, posées par le main (parity/platform.md §5) : l'interface peut demander une
// suppression, mais c'est cette boîte qui décide. Le bouton par défaut est toujours « Annuler ».
import { app, BrowserWindow, dialog } from "electron";
import { t } from "../core/l10n.ts";

export interface ConfirmRequest {
  message: string;
  detail?: string;
  /** Libellé du bouton qui exécute l'action. */
  confirm: string;
  /** Action irréversible : icône d'avertissement. */
  destructive?: boolean;
}

export type Confirmer = (request: ConfirmRequest) => Promise<boolean>;

/**
 * Réponse automatique pour les tests de bout en bout seulement (`CAIRN_E2E_CONFIRM=yes|no`), jamais dans l'app
 * empaquetée ni hors d'un dossier de données de test.
 */
function testAnswer(): boolean | null {
  if (app.isPackaged || !process.env.CAIRN_E2E_USER_DATA) return null;
  const v = process.env.CAIRN_E2E_CONFIRM;
  return v === "yes" ? true : v === "no" ? false : null;
}

/** Boîte de dialogue modale sur la fenêtre au premier plan (ou l'app). */
export const confirmWithDialog: Confirmer = async (request) => {
  const answer = testAnswer();
  if (answer !== null) return answer;
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const options: Electron.MessageBoxOptions = {
    type: request.destructive ? "warning" : "question",
    message: request.message,
    detail: request.detail,
    buttons: [request.confirm, t("action.cancel")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === 0;
};

/** Liste courte des éléments visés (5 au plus, puis « … et N de plus »). */
export function itemList(items: readonly string[], max = 5): string {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return [...shown, ...(more > 0 ? [t("confirm.more", more)] : [])].join("\n");
}
