import type { ScreenShot } from "./types.ts";

/** Captures du cadre de l'app : barre du haut, rail, état global, panneau de mise à jour. */
export const shots: ScreenShot[] = [
  { name: "shell.home", hash: "#/app/home" },
  { name: "shell.status-error", hash: "#/app/home", scenario: "backup-failed" },
  { name: "shell.backing-up", hash: "#/app/home", scenario: "backup-running", at: 20 },
  {
    name: "shell.rail-tooltip",
    hash: "#/app/home",
    before: async (page) => {
      await page.getByRole("button", { name: "Backups" }).hover();
      await page.waitForTimeout(500);
    },
  },
  {
    name: "shell.update",
    hash: "#/app/home",
    scenario: "update-available",
    before: async (page) => {
      await page.getByRole("button", { name: "Update available" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "shell.update-blocked",
    hash: "#/app/home",
    scenario: "update-available",
    before: async (page) => {
      await page.getByRole("button", { name: "Back up now" }).click();
      await page.getByRole("button", { name: "Update available" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "shell.update-fr",
    hash: "#/app/home",
    scenario: "update-available",
    lang: "fr",
    before: async (page) => {
      await page.getByRole("button", { name: "Mise à jour disponible" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
];
