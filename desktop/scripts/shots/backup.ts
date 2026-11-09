import type { Page } from "@playwright/test";
import type { ScreenShot } from "./types.ts";

async function openAdd(page: Page): Promise<void> {
  await page.getByRole("dialog").waitFor();
}

async function addStep(page: Page, kind: "Folder or disk" | "NAS (SMB)"): Promise<void> {
  await openAdd(page);
  await page.getByRole("radio", { name: new RegExp(kind.replace(/[()]/g, "\\$&")) }).click();
  await page.getByRole("button", { name: "Continue" }).click();
}

/**
 * Captures des Sauvegardes : page d'une destination, progression à plusieurs instants de la sauvegarde simulée à
 * deux destinations (préparation, comptage, copie, finalisation pendant que l'autre copie, résultat), échec,
 * feuilles Ajouter (chaque étape) / Modifier / Supprimer, rétention, mot de passe d'une image neuve.
 */
export const shots: ScreenShot[] = [
  { name: "backup.normal", hash: "#/app/backup" },
  { name: "backup.normal-fr", hash: "#/app/backup", lang: "fr" },
  { name: "backup.disk", hash: "#/app/backup/disk" },
  { name: "backup.empty", hash: "#/app/backup", scenario: "empty" },
  { name: "backup.running-01s", hash: "#/app/backup", scenario: "backup-running", at: 1 },
  { name: "backup.running-05s", hash: "#/app/backup", scenario: "backup-running", at: 5 },
  { name: "backup.running-05s-fr", hash: "#/app/backup", scenario: "backup-running", at: 5, lang: "fr" },
  { name: "backup.running-14s", hash: "#/app/backup", scenario: "backup-running", at: 14 },
  { name: "backup.running-24s", hash: "#/app/backup", scenario: "backup-running", at: 24 },
  { name: "backup.running-33s", hash: "#/app/backup", scenario: "backup-running", at: 33 },
  { name: "backup.running-done", hash: "#/app/backup", scenario: "backup-running", at: 40 },
  { name: "backup.simulated", hash: "#/app/backup", scenario: "backup-simulated", at: 40 },
  { name: "backup.simulated-fr", hash: "#/app/backup", scenario: "backup-simulated", at: 40, lang: "fr" },
  { name: "backup.no-full-disk-access", hash: "#/app/backup", scenario: "no-full-disk-access" },
  { name: "backup.no-full-disk-access-fr", hash: "#/app/backup", scenario: "no-full-disk-access", lang: "fr" },
  { name: "backup.failed", hash: "#/app/backup", scenario: "backup-failed" },
  { name: "backup.failed-disk", hash: "#/app/backup/disk", scenario: "backup-failed" },
  {
    name: "backup.menu",
    hash: "#/app/backup",
    before: async (page) => {
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menu").waitFor();
    },
  },
  {
    name: "backup.disabled-reason",
    hash: "#/app/backup",
    scenario: "backup-running",
    at: 14,
    before: async (page) => {
      await page.getByRole("button", { name: "Check integrity" }).hover();
      await page.waitForTimeout(500);
    },
  },
  { name: "backup.add-type", hash: "#/app/backup/add", before: openAdd },
  { name: "backup.add-local", hash: "#/app/backup/add", before: (page) => addStep(page, "Folder or disk") },
  {
    name: "backup.add-local-check",
    hash: "#/app/backup/add",
    before: async (page) => {
      await addStep(page, "Folder or disk");
      await page.getByRole("button", { name: "Archive" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByText("Destination verified").waitFor();
    },
  },
  {
    name: "backup.add-options",
    hash: "#/app/backup/add",
    before: async (page) => {
      await addStep(page, "Folder or disk");
      await page.getByRole("button", { name: "Archive" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByText("Destination verified").waitFor();
      await page.getByRole("button", { name: "Continue" }).click();
    },
  },
  {
    name: "backup.add-nas-shares",
    hash: "#/app/backup/add",
    before: async (page) => {
      await addStep(page, "NAS (SMB)");
      await page.getByRole("textbox", { name: "Share address" }).fill("smb://nas.local");
      await page.getByRole("textbox", { name: "User name" }).fill("romain");
      await page.getByRole("button", { name: "Connect" }).click();
      await page.getByText("Shared folders", { exact: true }).waitFor();
    },
  },
  {
    name: "backup.add-nas-browse",
    hash: "#/app/backup/add",
    lang: "fr",
    before: async (page) => {
      await page.getByRole("dialog").waitFor();
      await page.getByRole("radio", { name: /NAS/ }).click();
      await page.getByRole("button", { name: "Continuer" }).click();
      await page.getByRole("textbox", { name: "Adresse du partage" }).fill("smb://nas.local");
      await page.getByRole("button", { name: "Se connecter" }).click();
      await page.getByRole("button", { name: "backups" }).click();
      await page.getByRole("button", { name: "Se reconnecter" }).waitFor();
    },
  },
  {
    name: "backup.add-nas-check",
    hash: "#/app/backup/add",
    before: async (page) => {
      await addStep(page, "NAS (SMB)");
      await page.getByRole("textbox", { name: "Share address" }).fill("smb://nas.local/backups");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByText("Destination verified").waitFor();
    },
  },
  {
    name: "backup.edit",
    hash: "#/app/backup",
    before: async (page) => {
      await page.getByRole("button", { name: "Edit" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    name: "backup.remove",
    hash: "#/app/backup/disk",
    before: async (page) => {
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Delete destination…" }).click();
      await page.getByRole("radio", { name: /Also delete/ }).click();
      await page.getByRole("button", { name: "Simulate" }).click();
      await page.getByText("This Mac's backups —").waitFor();
    },
  },
  {
    name: "backup.retention-confirm",
    hash: "#/app/backup/disk",
    before: async (page) => {
      await page.getByRole("spinbutton", { name: "Versions kept" }).focus();
      await page.keyboard.press("ArrowDown");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  { name: "backup.new-image", hash: "#/app/backup", scenario: "backup-new-image" },
];
