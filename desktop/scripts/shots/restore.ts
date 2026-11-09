import type { Page } from "@playwright/test";
import type { ScreenShot } from "./types.ts";

/** Mac neuf (scénario `restore`) : NAS, mot de passe de l'image, version de l'ancien Mac. */
async function unlock(page: Page): Promise<void> {
  await page.getByRole("button", { name: "nas.local" }).click();
  await page.getByRole("textbox", { name: "Disk image password" }).fill("secret");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("heading", { name: "Which version?" }).waitFor();
}

async function toParts(page: Page): Promise<void> {
  await unlock(page);
  await page.getByRole("button", { name: /Nov 8, 2026/ }).click();
  await page.getByRole("heading", { name: "What do you want to restore?" }).waitFor();
}

async function toSummary(page: Page): Promise<void> {
  await toParts(page);
  await page.getByRole("checkbox", { name: "Documents" }).click();
  await page.getByRole("button", { name: "Simulate" }).click();
  await page.getByRole("heading", { name: "Summary" }).waitFor();
}

/**
 * Captures de la Restauration : choix de la source, mot de passe (Mac neuf), versions, contenu, récapitulatif
 * simulé (outils à réinstaller à la main), restauration en cours et terminée.
 */
export const shots: ScreenShot[] = [
  { name: "restore.source", hash: "#/app/restore" },
  { name: "restore.source-fr", hash: "#/app/restore", lang: "fr" },
  {
    name: "restore.password",
    hash: "#/app/restore",
    scenario: "restore",
    before: (page) => page.getByRole("button", { name: "nas.local" }).click(),
  },
  { name: "restore.versions", hash: "#/app/restore", scenario: "restore", before: unlock },
  { name: "restore.parts", hash: "#/app/restore", scenario: "restore", before: toParts },
  { name: "restore.summary", hash: "#/app/restore", scenario: "restore", before: toSummary },
  {
    name: "restore.running",
    hash: "#/app/restore",
    scenario: "restore",
    at: 0,
    before: async (page) => {
      await toSummary(page);
      await page.getByTestId("screen-restore").getByRole("button", { name: "Restore", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
      await page.getByRole("heading", { name: "Restore in progress" }).waitFor();
    },
  },
  {
    name: "restore.confirm",
    hash: "#/app/restore",
    scenario: "restore",
    before: async (page) => {
      await toSummary(page);
      await page.getByTestId("screen-restore").getByRole("button", { name: "Restore", exact: true }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "restore.missing-volume",
    hash: "#/app/restore",
    scenario: "restore",
    before: async (page) => {
      await toParts(page);
      await page.getByRole("checkbox", { name: "workspaces" }).click();
    },
  },
  {
    name: "restore.create-volume",
    hash: "#/app/restore",
    scenario: "restore",
    before: async (page) => {
      await toParts(page);
      await page.getByRole("checkbox", { name: "workspaces" }).click();
      await page.getByRole("button", { name: "Create the “workspaces” APFS volume" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "restore.done-fr",
    hash: "#/app/restore",
    scenario: "restore",
    lang: "fr",
    before: async (page) => {
      await page.getByRole("button", { name: "nas.local" }).click();
      await page.getByRole("textbox", { name: "Mot de passe de l'image disque" }).fill("secret");
      await page.getByRole("button", { name: "Déverrouiller" }).click();
      await page.getByRole("button", { name: /8 nov\. 2026/ }).click();
      await page.getByRole("button", { name: "Simuler" }).click();
      await page.getByTestId("screen-restore").getByRole("button", { name: "Restaurer", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Restaurer", exact: true }).click();
      await page.getByRole("heading", { name: "Restauration terminée" }).waitFor({ timeout: 20_000 });
    },
  },
];
