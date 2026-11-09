import type { ScreenShot } from "./types.ts";

/** Captures de l'écran Outils IA : destinations chiffrées, puis une destination non chiffrée (identifiants exclus). */
export const shots: ScreenShot[] = [
  { name: "ai.tools", hash: "#/app/ai" },
  { name: "ai.tools.fr", hash: "#/app/ai", lang: "fr" },
  {
    name: "ai.credentials.blocked",
    hash: "#/app/ai",
    scenario: "unencrypted-destination",
    before: async (page) => {
      await page
        .getByText(/^Credentials ·/)
        .last()
        .hover({ force: true });
      await page.waitForTimeout(500);
    },
  },
  { name: "ai.backup.running", hash: "#/app/ai", scenario: "backup-running", at: 5 },
  { name: "ai.empty", hash: "#/app/ai", scenario: "empty" },
];
