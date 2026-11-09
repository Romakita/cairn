// Écran Outils CLI sur l'interface seule (dev-web, API d'exemple) : recensement, statuts, exclusions, export.
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5192;
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
  await expect(page.getByTestId("screen-tools")).toBeVisible();
  return page;
}

/** Infobulle montrée au survol d'un élément (raison d'une action indisponible). */
async function tooltipOf(_page: Page, target: ReturnType<Page["getByRole"]>): Promise<void> {
  await target.hover({ force: true });
}

test("recensement à l'ouverture, filtre par statut, raisons", async () => {
  const page = await open("tools");
  await expect(page.getByText("9 of 9 tools kept").first()).toBeVisible();
  await page.getByRole("tab", { name: /Missing/ }).click();
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(page.getByRole("row", { name: /kubectl/ })).toContainText("~/.kube");
  const keep = page.getByRole("checkbox", { name: "Keep kubectl in the export" });
  await expect(keep).toHaveAttribute("aria-disabled", "true");
  await tooltipOf(page, keep);
  await expect(page.getByRole("tooltip")).toHaveText("Not installed on this Mac: nothing to export.");
  await page.close();
});

test("exclure un outil puis exporter la liste retenue", async () => {
  const page = await open("tools", "unencrypted-destination");
  await expect(page.getByText("8 of 9 tools kept").first()).toBeVisible();
  await page.getByRole("checkbox", { name: "Keep ripgrep in the export" }).click();
  await expect(page.getByText("7 of 9 tools kept").first()).toBeVisible();
  await page.getByRole("button", { name: "Export…" }).click();
  await expect(page.getByText("7 tools exported to /Users/demo/Desktop")).toBeVisible();
  await page.close();
});
