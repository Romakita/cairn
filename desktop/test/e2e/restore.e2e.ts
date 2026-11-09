// Restauration sur l'interface seule (dev-web, API d'exemple) : source, mot de passe (Mac neuf), version, contenu,
// récapitulatif simulé (outils à réinstaller à la main), restauration appliquée et sa progression.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, _electron as electron, expect, type Page, test } from "@playwright/test";
import type { CairnApi } from "../../src/shared/contract.ts";
import { desktopRoot, temporaryHome } from "./helpers.ts";

const PORT = 5196;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/?scenario=${scenario}#/app/restore`);
  await expect(page.getByTestId("screen-restore")).toBeVisible();
  return page;
}

const screen = (page: Page) => page.getByTestId("screen-restore");

test("Mac neuf : mot de passe de l'image, version de l'ancien Mac, simulation puis restauration", async () => {
  const page = await open("restore");
  await expect(page.getByRole("heading", { name: "Where is the backup?" })).toBeVisible();
  await page.getByRole("button", { name: "nas.local" }).click();
  const unlock = page.getByRole("button", { name: "Unlock" });
  await expect(unlock).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("textbox", { name: "Disk image password" }).fill("secret");
  await unlock.click();
  await expect(page.getByRole("heading", { name: "Which version?" })).toBeVisible();
  await expect(page.getByText("MacBook-Pro-2019").first()).toBeVisible();
  await page.getByRole("button", { name: /Nov 8, 2026/ }).click();
  await expect(page.getByRole("heading", { name: "What do you want to restore?" })).toBeVisible();
  await page.getByRole("checkbox", { name: "workspaces" }).click();
  await expect(page.getByText("/Volumes/workspaces does not exist on this Mac.")).toBeVisible();
  await screen(page).getByRole("button", { name: "Simulate" }).click();
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
  // go et ~/.local/bin : listés à réinstaller à la main, avec leur version.
  await expect(page.getByText("2 tools to reinstall by hand (not installed automatically):")).toBeVisible();
  await expect(page.getByText("v0.16.2")).toBeVisible();
  await expect(page.getByText(/Warning: backup made on x86_64/)).toBeVisible();
  await screen(page).getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Restore in progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Restore finished" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Restore something else" })).toBeVisible();
  await page.close();
});

test("« Continuer » est désactivé tant que rien n'est choisi, avec sa raison", async () => {
  const page = await open();
  const next = screen(page).getByRole("button", { name: "Continue" });
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await next.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Choose where the backup is.");
  await page.getByRole("button", { name: "nas.local" }).click();
  await expect(page.getByRole("heading", { name: "Which version?" })).toBeVisible();
  await expect(page.getByText(/this Mac/).first()).toBeVisible();
  await page.close();
});

test("vraie app : plan et simulation d'une version Cairn, application refusée sans confirmation", async () => {
  const home = await temporaryHome();
  // Version Cairn minimale : manifest et partie home (rien n'est écrit hors du dossier temporaire).
  const version = path.join(home, "backup", "cairn", "Old-Mac", "versions", "2026-11-08T123000");
  await mkdir(path.join(version, "home", ".config"), { recursive: true });
  await writeFile(path.join(version, "home", ".config", "settings.txt"), "x".repeat(5000));
  await writeFile(
    path.join(version, "manifest.json"),
    JSON.stringify({
      format: 1,
      date: "2026-11-08T12:30:00Z",
      machine: "Old-Mac",
      arch: "arm64",
      parts: [{ kind: "home", target: "home", source: "/Users/old" }],
    }),
  );
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const app = await electron.launch({
    args: [desktopRoot],
    cwd: desktopRoot,
    env: {
      ...env,
      CAIRN_HOME: home,
      CAIRN_E2E_USER_DATA: path.join(home, ".electron"),
      CAIRN_TOOLS_INVENTORY: "empty",
      CAIRN_UPDATE_URL: "http://127.0.0.1:9/none",
      CAIRN_E2E_CONFIRM: "no",
    },
  });
  const window = await app.firstWindow();
  await expect(window.getByTestId("app-root")).toBeAttached();
  const result = await window.evaluate(
    async (root) => {
      const api = (window as unknown as { cairn: CairnApi }).cairn;
      // Racine d'une destination : les versions de toutes les machines sont listées.
      const listed = await api.planRestore({ source: { kind: "folder", path: root } });
      const plan = await api.planRestore({ source: { kind: "folder", path: root }, parts: ["home"], simulate: true });
      const applied = await api.applyRestore({ planId: plan.planId });
      const snapshot = await api.getSnapshot();
      return { listed, plan, applied, restore: snapshot.restore };
    },
    path.join(home, "backup"),
  );
  expect(result.listed.versions.map((v) => [v.machine, v.name])).toEqual([["Old-Mac", "2026-11-08T123000"]]);
  expect(result.listed.details?.home).toBe(true);
  expect(result.plan.simulated).toBe(true);
  expect(result.plan.parts).toEqual(["home"]);
  expect(result.plan.sizes.home).toBeGreaterThan(0);
  expect(result.plan.steps.map((x) => x.step)).toEqual(["home"]);
  expect(result.applied).toEqual({ cancelled: true });
  expect(result.restore.available).toBe(true);
  expect(result.restore.running).toBe(false);
  await app.close();
});
