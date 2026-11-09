import type { ScreenShot } from "./types.ts";

/** Captures de l'accueil : états du hub, vérification en cours, problèmes prioritaires, largeur minimale. */
export const shots: ScreenShot[] = [
  { name: "home.normal", hash: "#/app/home" },
  { name: "home.fr", hash: "#/app/home", lang: "fr" },
  { name: "home.backup-failed", hash: "#/app/home", scenario: "backup-failed" },
  { name: "home.disk-critical", hash: "#/app/home", scenario: "disk-critical" },
  { name: "home.config-invalid", hash: "#/app/home", scenario: "config-invalid" },
  { name: "home.no-full-disk-access", hash: "#/app/home", scenario: "no-full-disk-access" },
  { name: "home.no-full-disk-access-fr", hash: "#/app/home", scenario: "no-full-disk-access", lang: "fr" },
  { name: "home.backup-running", hash: "#/app/home", scenario: "backup-running", at: 20 },
  {
    name: "home.checking",
    hash: "#/app/home",
    at: 1,
    before: async (page) => {
      await page.getByRole("button", { name: "Check everything" }).click();
      await page.getByRole("button", { name: "Stop" }).waitFor();
    },
  },
  {
    name: "home.check-help",
    hash: "#/app/home",
    before: async (page) => {
      await page.getByRole("button", { name: "Check everything" }).hover();
      await page.waitForTimeout(500);
    },
  },
  { name: "home.narrow", hash: "#/app/home", viewport: { width: 1100, height: 720 } },
];
