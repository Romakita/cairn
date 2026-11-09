import type { Page } from "@playwright/test";
import type { ScreenShot } from "./types.ts";

async function continueTo(page: Page, steps: number) {
  await page.getByRole("button", { name: /^(Continue|Continuer)$/ }).waitFor();
  for (let i = 0; i < steps; i++) await page.getByRole("button", { name: /^(Continue|Continuer)$/ }).click();
}

/** Captures des réglages et de l'assistant de premier lancement. */
export const shots: ScreenShot[] = [
  { name: "settings.normal", hash: "#/app/settings" },
  { name: "settings.fr", hash: "#/app/settings", lang: "fr" },
  {
    name: "settings.schedule",
    hash: "#/app/settings",
    before: async (page) => {
      await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Schedule" }).click();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "settings.alerts",
    hash: "#/app/settings",
    before: async (page) => {
      await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Maintenance" }).click();
      await page.waitForTimeout(600);
    },
  },
  { name: "settings.config-invalid", hash: "#/app/settings", scenario: "config-invalid" },
  {
    name: "settings.remove-folder",
    hash: "#/app/settings",
    before: async (page) => {
      await page.getByRole("button", { name: "Stop tracking" }).first().click();
      await page.getByRole("dialog").waitFor();
    },
  },
  { name: "settings.onboarding-folders", hash: "#/app/home", scenario: "empty" },
  { name: "settings.onboarding-folders-fr", hash: "#/app/home", scenario: "empty", lang: "fr" },
  { name: "settings.onboarding-home", hash: "#/app/home", scenario: "empty", before: (p) => continueTo(p, 1) },
  { name: "settings.onboarding-ai", hash: "#/app/home", scenario: "empty", before: (p) => continueTo(p, 2) },
  {
    name: "settings.onboarding-destination",
    hash: "#/app/home",
    scenario: "empty",
    before: async (page) => {
      await continueTo(page, 3);
      await page.getByRole("radio", { name: /NAS \(SMB\)/ }).click();
    },
  },
  { name: "settings.onboarding-schedule", hash: "#/app/home", scenario: "empty", before: (p) => continueTo(p, 4) },
  {
    name: "settings.onboarding-summary",
    hash: "#/app/home",
    scenario: "empty",
    before: (p) => continueTo(p, 5),
  },
];
