// Écran Outils IA sur l'interface seule (dev-web, API d'exemple) : catégories, identifiants exclus avec leur raison,
// jeton au Trousseau, sauvegarde des outils IA.
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5193;
let server: ChildProcess;
let browser: Browser;

test.beforeAll(async () => {
  server = spawn("bun", ["scripts/dev-web.ts", "--port", String(PORT), "--no-watch"], { cwd: desktopRoot });
  await new Promise<void>((resolve, reject) => {
    server.stdout?.on("data", (d: Buffer) => d.toString().includes("Interface") && resolve());
    server.on("exit", (code) => reject(new Error(`dev-web s'est arrêté (${code})`)));
  });
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
  server?.kill();
});

async function open(route: string, scenario = "normal", extra = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/?scenario=${scenario}${extra}#/app/${route}`);
  await expect(page.getByTestId("screen-ai")).toBeVisible();
  return page;
}

test("catégories cochées, jeton au Trousseau signalé, case cochée enregistrée", async () => {
  const page = await open("ai");
  await expect(page.getByText("Credentials can be included")).toBeVisible();
  const claude = page.getByRole("region", { name: "Claude Code" });
  await expect(claude.getByText(/sign-in token stays in the macOS Keychain/)).toBeVisible();
  const codex = page.getByRole("region", { name: "Codex" });
  const memories = codex.getByRole("button", { name: /^Memories/ });
  await expect(memories).toHaveAttribute("aria-pressed", "false");
  await memories.click();
  await expect(memories).toHaveAttribute("aria-pressed", "true");
  await page.close();
});

test("destination non chiffrée : identifiants désactivés avec leur raison", async () => {
  const page = await open("ai", "unencrypted-destination");
  await expect(page.getByText(/credentials are not backed up, even when checked/)).toBeVisible();
  const codex = page.getByRole("region", { name: "Codex" });
  const chip = codex.locator('[aria-disabled="true"]', { hasText: "Credentials" });
  await expect(chip).toHaveAttribute(
    "aria-description",
    "Credentials are checked but ignored: every destination must be encrypted.",
  );
  await chip.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Credentials are checked but ignored: every destination must be encrypted.",
  );
  await page.close();
});

test("sauvegarde des outils IA : indisponible pendant une sauvegarde, sinon ouvre la progression", async () => {
  let page = await open("ai", "backup-running", "&frozen=1");
  await expect(page.getByRole("button", { name: "Back up AI tools" })).toHaveAttribute(
    "aria-description",
    "Unavailable while a backup is running.",
  );
  await page.close();
  page = await open("ai");
  await page.getByRole("button", { name: "Back up AI tools" }).click();
  await expect(page.getByTestId("screen-backup")).toBeVisible();
  await page.close();
});
