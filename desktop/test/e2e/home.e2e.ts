// Accueil sur l'interface seule (dev-web, API d'exemple) : « Tout vérifier », « Résoudre », actions des cartes.
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5182;
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

async function open(scenario = "normal", extra = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/?scenario=${scenario}${extra}#/app/home`);
  await expect(page.getByTestId("screen-home")).toBeVisible();
  return page;
}

test("état global, cinq cartes de module et activité récente", async () => {
  const page = await open();
  await expect(page.getByRole("heading", { name: "Everything is in order" })).toBeVisible();
  for (const name of ["Storage", "Backup", "Git", "AI tools", "Restore"])
    await expect(page.getByRole("article", { name })).toBeVisible();
  await expect(page.getByText("Backup to nas.local succeeded")).toBeVisible();
  await page.close();
});

test("« Tout vérifier » se lance en lecture seule et s'arrête", async () => {
  const page = await open("normal", "&frozen=1");
  const check = page.getByRole("button", { name: "Check everything" });
  await check.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Read-only check: nothing is deleted, cleaned or backed up.");
  await check.click();
  await expect(page.getByText("Checking…").first()).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Check everything" })).toBeVisible();
  await page.close();
});

test("« Résoudre » d'un disque critique ouvre Nettoyable, sans rien supprimer", async () => {
  const page = await open("disk-critical");
  await expect(page.getByText("workspaces is nearly full: only 3.1 GB free").first()).toBeVisible();
  await page.getByRole("button", { name: "Resolve" }).click();
  expect(page.url()).toContain("#/app/clean");
  await page.close();
});

test("« Sauvegarder maintenant » est désactivé avec sa raison quand la configuration est invalide", async () => {
  const page = await open("config-invalid");
  const backup = page.getByRole("article", { name: "Backup" }).getByRole("button", { name: "Back up now" });
  await expect(backup).toHaveAttribute("aria-disabled", "true");
  await backup.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Fix config.toml before backing up: its schedule is paused.");
  await page.close();
});

test("la barre latérale mène aux destinations et aux dossiers", async () => {
  const page = await open();
  const sidebar = page.getByRole("navigation", { name: "Home" });
  await sidebar.getByRole("button", { name: /nas\.local/ }).click();
  expect(page.url()).toContain("#/app/backup/nas");
  await page.close();
});
