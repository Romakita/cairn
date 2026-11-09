import type { ScreenShot } from "./types.ts";

const viewport = { width: 360, height: 560 };

/** Captures du panneau de la barre des menus (360 de large). */
export const shots: ScreenShot[] = [
  { name: "menubar.normal", hash: "#/menubar", viewport },
  { name: "menubar.fr", hash: "#/menubar", viewport, lang: "fr" },
  { name: "menubar.disk-critical", hash: "#/menubar", viewport, scenario: "disk-critical" },
  { name: "menubar.backup-running", hash: "#/menubar", viewport, scenario: "backup-running", at: 20 },
  { name: "menubar.no-analysis", hash: "#/menubar", viewport, scenario: "empty" },
  {
    name: "menubar.more",
    hash: "#/menubar",
    viewport,
    before: async (page) => {
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menu").waitFor();
    },
  },
];
