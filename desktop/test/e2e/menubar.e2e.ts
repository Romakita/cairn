// Panneau de la barre des menus sur l'interface seule (dev-web, API d'exemple).
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5184;
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

async function open(scenario = "normal"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 360, height: 560 } });
  await page.goto(`http://localhost:${PORT}/?scenario=${scenario}#/menubar`);
  await expect(page.getByTestId("menubar-panel")).toBeVisible();
  return page;
}

test("état, espace libre, récupérable et actions rapides", async () => {
  const page = await open();
  await expect(page.getByText("412 GB")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clean up 10.91 GB" })).not.toHaveAttribute("aria-disabled");
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText("Backup in progress").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Back up now" })).toHaveAttribute("aria-disabled", "true");
  await page.close();
});

test("menu « … » au clavier : Analyser, Ouvrir, Réglages, Quitter en dernier", async () => {
  const page = await open();
  await page.getByRole("button", { name: "More actions" }).focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items.last()).toHaveText("Quit Cairn");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.close();
});

test("sans analyse : « Nettoyer » désactivé avec sa raison, analyse proposée", async () => {
  const page = await open("empty");
  const clean = page.getByRole("button", { name: /Clean up/ });
  await expect(clean).toHaveAttribute("aria-disabled", "true");
  await clean.hover();
  await expect(page.getByRole("tooltip")).toHaveText("No analysis yet");
  await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();
  await page.close();
});

test("disque critique : alerte et « Ignorer 7 jours »", async () => {
  const page = await open("disk-critical");
  await expect(page.getByText("workspaces is critically full")).toBeVisible();
  await page.getByRole("button", { name: "Ignore for 7 days" }).click();
  await expect(page.getByText("workspaces is critically full")).toHaveCount(0);
  await page.close();
});
