// Réglages et assistant sur l'interface seule (dev-web, API d'exemple).
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5183;
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
  return page;
}

test("une bascule enregistre la configuration", async () => {
  const page = await open("#/app/settings");
  const toggle = page.getByRole("switch", { name: "Back up ~/Documents" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.close();
});

test("ne plus suivre un dossier demande une confirmation", async () => {
  const page = await open("#/app/settings");
  await page.getByRole("button", { name: "Stop tracking" }).nth(1).click();
  const sheet = page.getByRole("dialog", { name: "Stop tracking ~/Documents?" });
  await sheet.getByRole("button", { name: "Cancel" }).click();
  const folders = page.getByRole("region", { name: "Tracked folders" });
  await expect(folders.getByText("~/Documents", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop tracking" }).nth(1).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop tracking" }).click();
  await expect(folders.getByText("~/Documents", { exact: true })).toHaveCount(0);
  await page.close();
});

test("fréquence hebdomadaire : choix du jour au clavier ; heure invalide signalée", async () => {
  const page = await open("#/app/settings");
  await page
    .getByRole("radio", { name: "Weekly" })
    .or(page.getByRole("tab", { name: "Weekly" }))
    .click();
  const day = page.getByRole("button", { name: "Day, Monday" });
  await day.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu")).toBeVisible();
  await page
    .getByRole("menuitemradio", { name: "Friday" })
    .or(page.getByRole("menuitem", { name: "Friday" }))
    .click();
  await expect(page.getByRole("button", { name: "Day, Friday" })).toBeVisible();

  const time = page.getByRole("textbox", { name: "Time" });
  await time.fill("25:00");
  await expect(page.getByText("Enter a time as HH:MM, for example 12:30.")).toBeVisible();
  await page.close();
});

test("configuration invalide : bandeau avec la clé et la ligne, modifications refusées avec la raison", async () => {
  const page = await open("#/app/settings", "config-invalid");
  await expect(page.getByText("Key schedule.time, line 42.", { exact: false })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Back up ~/Documents" });
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await toggle.hover();
  await expect(page.getByRole("tooltip")).toContainText("config.toml contains an error");
  await toggle.click({ force: true });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.close();
});

test("assistant : étape bloquée avec sa raison, puis « Terminer » écrit la configuration", async () => {
  const page = await open("#/app/home", "empty");
  await expect(page.getByTestId("screen-onboarding")).toBeVisible();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Deselect all" }).click();
  const next = page.getByRole("button", { name: "Continue" });
  await expect(next).toHaveAttribute("aria-description", "Select at least one folder.");
  await page.getByRole("button", { name: "Select all" }).click();
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Stay informed" })).toBeVisible();
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByTestId("screen-home")).toBeVisible();
  await page.close();
});
