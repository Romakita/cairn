// Cadre de l'app sur l'interface seule (dev-web, API d'exemple) : rail, indicateur d'état, mise à jour, ⌘,.
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5181;
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

async function open(hash: string, scenario = "normal"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/?scenario=${scenario}${hash}`);
  await expect(page.getByTestId("shell")).toBeVisible();
  return page;
}

test("le rail change d'écran, met à jour l'URL et montre le nom de la section au survol", async () => {
  const page = await open("#/app/home");
  const rail = page.getByRole("navigation", { name: "Sections" });
  await rail.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("screen-settings")).toBeVisible();
  expect(page.url()).toContain("#/app/settings");
  await expect(rail.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  await rail.getByRole("button", { name: "Backups" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Backups");
  await page.close();
});

test("⌘, ouvre les réglages ; une route inconnue ramène à l'accueil", async () => {
  const page = await open("#/app/nowhere");
  await expect(page.getByTestId("screen-home")).toBeVisible();
  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("screen-settings")).toBeVisible();
  await page.close();
});

test("l'indicateur d'état mène à la cause du problème prioritaire", async () => {
  const page = await open("#/app/home", "backup-failed");
  const status = page.getByRole("button", { name: "Error" });
  await status.hover();
  await expect(page.getByRole("tooltip")).toHaveText("The last backup to nas.local failed");
  await status.click();
  expect(page.url()).toContain("#/app/backup/nas");
  await page.close();
});

test("mise à jour : panneau avec notes, installation désactivée avec sa raison pendant une sauvegarde", async () => {
  const page = await open("#/app/home", "update-available");
  const button = page.getByRole("button", { name: "Update available" });
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Update available" });
  await expect(dialog.getByRole("heading", { name: "Cairn 0.10.0 is available" })).toBeVisible();
  await expect(dialog.getByText("verify a destination before saving it")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Install and relaunch" })).not.toHaveAttribute("aria-disabled");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByRole("button", { name: "Backup in progress" })).toBeVisible();
  await button.click();
  const install = page.getByRole("dialog").getByRole("button", { name: "Install and relaunch" });
  const reason = "A backup is running: the update can be installed once it finishes.";
  await expect(install).toHaveAttribute("aria-disabled", "true");
  await expect(install).toHaveAttribute("aria-description", reason);
  await install.hover();
  await expect(page.getByRole("tooltip")).toHaveText(reason);
  await page.close();
});
