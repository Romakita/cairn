// Écran Git sur l'interface seule (dev-web, API d'exemple) : onglets, menus « … », confirmations avec case dédiée,
// suppressions indisponibles pendant l'analyse, analyse d'un seul dépôt.
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5191;
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
  await expect(page.getByTestId("screen-git")).toBeVisible();
  return page;
}

/** Infobulle montrée au survol d'un élément (raison d'une action indisponible). */
async function tooltipOf(_page: Page, target: ReturnType<Page["getByRole"]>): Promise<void> {
  await target.hover({ force: true });
}

test("onglets et branche extraite dans un worktree : suppression indisponible, avec sa raison", async () => {
  const page = await open("git");
  await expect(page.getByRole("tab", { name: "Repositories" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Branches" }).click();
  await page
    .getByRole("row", { name: /feat\/menu-bar/ })
    .getByRole("button", { name: "Actions" })
    .click();
  const item = page.getByRole("menuitem", { name: "Delete branch…" });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await tooltipOf(page, item);
  await expect(page.getByRole("tooltip")).toHaveText("Checked out in a worktree: remove the worktree instead");
  await page.close();
});

test("worktree à risque : case dédiée requise, branche non cochée, ligne retirée", async () => {
  const page = await open("git");
  await page.getByRole("tab", { name: "Worktrees" }).click();
  await page
    .getByRole("row", { name: /menu-bar/ })
    .getByRole("button", { name: "Actions" })
    .click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("checkbox", { name: /Also delete its branch/ })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  const remove = sheet.getByRole("button", { name: "Delete" });
  await expect(remove).toHaveAttribute("aria-disabled", "true");
  await sheet.getByRole("checkbox", { name: "I understand what will be lost" }).click();
  await remove.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("0 branches and 1 worktree deleted.")).toBeVisible();
  await expect(page.getByRole("row", { name: /menu-bar/ })).toHaveCount(0);
  await page.close();
});

test("dépôt à risque mis à la corbeille après la case dédiée ; compactage confirmé", async () => {
  const page = await open("git");
  await page.getByRole("row", { name: /^api/ }).getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Move repository to Trash…" }).click();
  let sheet = page.getByRole("dialog");
  await sheet.getByRole("checkbox", { name: "I understand what will be lost" }).click();
  await sheet.getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByRole("row", { name: /^api/ })).toHaveCount(0);

  await page
    .getByRole("row", { name: /^cairn/ })
    .getByRole("button", { name: "Actions" })
    .click();
  await page.getByRole("menuitem", { name: "Compact (git gc)…" }).click();
  sheet = page.getByRole("dialog");
  // Élaguer tout de suite : case à cocher, décochée par défaut.
  const prune = sheet.getByRole("checkbox", { name: "Also free the space of deleted branches now" });
  await expect(prune).toHaveAttribute("aria-checked", "false");
  await prune.click();
  await sheet.getByRole("button", { name: "Compact" }).click();
  await expect(page.getByText(/^cairn compacted: \.git went from .+ to .+\.$/)).toBeVisible();
  await page.close();
});

test("pendant l'analyse (79 dépôts) : rapports affichés, suppressions indisponibles", async () => {
  const page = await open("git", "git-many-repos");
  await expect(page.getByText("Repositories analyzed: 64 of 79")).toBeVisible();
  await expect(page.getByText("1 repository could not be analyzed")).toBeVisible();
  await page.getByRole("button", { name: "Actions" }).first().click();
  const trash = page.getByRole("menuitem", { name: "Move repository to Trash…" });
  await expect(trash).toHaveAttribute("aria-description", "Available once the analysis is finished");
  await page.close();
});

test("analyser un seul dépôt filtre l'écran ; « Tous les dépôts » retire le filtre", async () => {
  const page = await open("git");
  await page
    .getByRole("row", { name: /^website/ })
    .getByRole("button", { name: "Actions" })
    .click();
  await page.getByRole("menuitem", { name: "Analyze this repository only" }).click();
  await expect(page.getByText("Repository: website")).toBeVisible();
  await page.getByRole("button", { name: "All repositories" }).click();
  await expect(page.getByText("Repository: website")).toHaveCount(0);
  await page.close();
});
