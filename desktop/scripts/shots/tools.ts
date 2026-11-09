import type { ScreenShot } from "./types.ts";

/** Captures de l'écran Outils CLI : inventaire, filtre, recensement en cours, exclusions. */
export const shots: ScreenShot[] = [
  { name: "tools.list", hash: "#/app/tools", scenario: "unencrypted-destination" },
  { name: "tools.list.fr", hash: "#/app/tools", scenario: "unencrypted-destination", lang: "fr" },
  {
    name: "tools.missing",
    hash: "#/app/tools",
    scenario: "unencrypted-destination",
    before: async (page) => page.getByRole("tab", { name: /Missing/ }).click(),
  },
  {
    name: "tools.keep.reason",
    hash: "#/app/tools",
    scenario: "unencrypted-destination",
    before: async (page) => {
      await page.getByRole("checkbox", { name: "Keep kubectl in the export" }).hover();
      await page.waitForTimeout(500);
    },
  },
  // Inventaire dressé à l'ouverture ; horloge figée : il reste « en cours ».
  { name: "tools.collecting", hash: "#/app/tools", at: 0 },
];
