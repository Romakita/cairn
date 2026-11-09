import type { ScreenShot } from "./types.ts";

/** Captures de la zone « storage » : écran Analyse, ses quatre onglets et ses états. */
export const shots: ScreenShot[] = [
  { name: "storage.overview", hash: "#/app/storage" },
  { name: "storage.overview.fr", hash: "#/app/storage", lang: "fr" },
  { name: "storage.explorer", hash: "#/app/explorer" },
  {
    name: "storage.explorer.menu",
    hash: "#/app/explorer",
    before: async (page) => {
      await page.getByRole("row", { name: /workspaces/ }).dblclick();
      await page
        .getByRole("row", { name: /node_modules/ })
        .getByRole("button", { name: "Actions" })
        .click();
    },
  },
  { name: "storage.clean", hash: "#/app/clean" },
  {
    // Arrivée depuis l'alerte de disque critique : « Nettoyer » ouvre Nettoyable avec les plus gros dossiers cochés.
    name: "storage.clean.preselected",
    hash: "#/app/storage",
    scenario: "disk-critical",
    before: async (page) =>
      page.getByRole("status").or(page.getByRole("alert")).getByRole("button", { name: "Clean up" }).click(),
  },
  {
    name: "storage.clean.confirm",
    hash: "#/app/clean",
    before: async (page) => {
      await page.getByRole("checkbox", { name: /cairn\/desktop\/node_modules/ }).click();
      await page.getByRole("checkbox", { name: /DerivedData/ }).click();
      await page.getByRole("button", { name: "Move to Trash…" }).last().click();
    },
  },
  {
    name: "storage.projects",
    hash: "#/app/storage",
    before: async (page) => page.getByRole("tab", { name: "Projects" }).click(),
  },
  { name: "storage.running", hash: "#/app/storage", scenario: "analysis-running", at: 3 },
  { name: "storage.critical", hash: "#/app/storage", scenario: "disk-critical" },
  { name: "storage.empty", hash: "#/app/storage", scenario: "empty" },
  { name: "storage.clean.fr", hash: "#/app/clean", lang: "fr" },
];
