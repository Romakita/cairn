// Menu de l'application (port des `CommandGroup` d'App.swift, 0.8.0) : « Rechercher les mises à jour… » après
// « À propos », Réglages (⌘,), « Choisir un dossier… » (⌘O) et « Analyser à nouveau » (⌘R) dans Fichier. Les menus
// Édition et Fenêtre gardent les rôles standard (copier-coller dans les champs, ⌘W, ⌘M).
import { Menu, type MenuItemConstructorOptions } from "electron";
import { t } from "../core/l10n.ts";

export interface AppMenuActions {
  checkForUpdates: () => void;
  openSettings: () => void;
  chooseFolder: () => void;
  rescan: () => void;
}

export function appMenuTemplate(actions: AppMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { label: t("update.check"), click: actions.checkForUpdates },
        { type: "separator" },
        { label: `${t("section.settings")}…`, accelerator: "CommandOrControl+,", click: actions.openSettings },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: t("menu.quit") },
      ],
    },
    {
      role: "fileMenu",
      submenu: [
        { label: t("action.choose_folder"), accelerator: "CommandOrControl+O", click: actions.chooseFolder },
        { label: t("action.rescan"), accelerator: "CommandOrControl+R", click: actions.rescan },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
}

/** Installe le menu ; à rappeler quand la langue change (les libellés sont traduits à la construction). */
export function installAppMenu(actions: AppMenuActions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(actions)));
}
