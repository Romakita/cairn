// Écran Analyse sur l'interface seule (dev-web, API d'exemple) : onglets, explorateur, nettoyage confirmé,
// présélection depuis l'alerte, analyse en cours, raisons d'indisponibilité, menus au clavier.
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5190;
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
  await expect(page.getByTestId("screen-storage")).toBeVisible();
  return page;
}

/** Infobulle montrée au survol d'un élément (raison d'une action indisponible). */
async function tooltipOf(_page: Page, target: ReturnType<Page["getByRole"]>): Promise<void> {
  await target.hover({ force: true });
}

test("onglets et explorateur : ouvrir un dossier, revenir avec ⌘↑", async () => {
  const page = await open("storage");
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("figure", { name: "By type" })).toBeVisible();
  await page.getByRole("tab", { name: "Explorer" }).click();
  await expect(page.getByTestId("screen-storage")).toHaveAttribute("data-tab", "explorer");
  await page.getByRole("row", { name: /workspaces/ }).dblclick();
  await expect(page.getByRole("row", { name: /node_modules/ })).toBeVisible();
  await page.keyboard.press("Meta+ArrowUp");
  await expect(page.getByRole("row", { name: /Documents/ })).toBeVisible();
  await page.close();
});

test("nettoyable : sélection, confirmation, corbeille par défaut", async () => {
  const page = await open("clean");
  const trash = page.getByRole("button", { name: "Move to Trash…" });
  await expect(trash).toHaveAttribute("aria-description", "Select at least one folder.");
  await tooltipOf(page, trash);
  await expect(page.getByRole("tooltip")).toHaveText("Select at least one folder.");
  await page.getByRole("checkbox", { name: /website\/node_modules/ }).click();
  await trash.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading")).toHaveText(/Move 1 item\(s\) to the Trash/);
  await sheet.getByRole("checkbox", { name: /Delete permanently/ }).click();
  await expect(sheet.getByRole("button", { name: "Delete permanently" })).toBeVisible();
  await sheet.getByRole("checkbox", { name: /Delete permanently/ }).click();
  await sheet.getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/1 item deleted/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /website\/node_modules/ })).toHaveCount(0);
  await page.close();
});

test("alerte de disque critique : « Nettoyer » ouvre Nettoyable avec la présélection, « Ignorer » la masque", async () => {
  const page = await open("storage", "disk-critical");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("workspaces is critically full");
  await alert.getByRole("button", { name: "Clean up" }).click();
  await expect(page.getByTestId("screen-storage")).toHaveAttribute("data-tab", "clean");
  await expect(page.getByText(/largest folders are selected/)).toBeVisible();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(4);
  await alert.getByRole("button", { name: "Ignore for 7 days" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.close();
});

test("analyse en cours : progression puis arrêt", async () => {
  const page = await open("storage", "analysis-running", "&frozen=1&t=2");
  await expect(page.getByRole("heading", { name: "Analyzing workspaces…" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Analyzing workspaces…" })).toHaveCount(0);
  await page.close();
});

test("menu d'une ligne au clavier : flèche bas ouvre, Échap ferme, corbeille en dernier", async () => {
  const page = await open("clean");
  const more = page.getByRole("row", { name: /DerivedData/ }).getByRole("button", { name: "Actions" });
  await more.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expect(menu.getByRole("menuitem").last()).toHaveText("Move to Trash…");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.close();
});
