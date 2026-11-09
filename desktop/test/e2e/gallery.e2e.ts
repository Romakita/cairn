import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { desktopRoot, temporaryHome } from "./helpers.ts";

const electronBinary = path.join(desktopRoot, "node_modules/.bin/electron");

/** Environnement isolé : `CAIRN_HOME` et profil Electron dans le dossier temporaire du test. */
function isolatedEnv(home: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  return { ...env, CAIRN_HOME: home, CAIRN_E2E_USER_DATA: path.join(home, ".electron") };
}

async function launchGallery(): Promise<{ app: ElectronApplication; window: Page }> {
  const home = await temporaryHome();
  const app = await electron.launch({ args: [desktopRoot, "--gallery"], cwd: desktopRoot, env: isolatedEnv(home) });
  const window = await app.firstWindow();
  await expect(window.getByTestId("app-root")).toHaveAttribute("data-route", "gallery");
  return { app, window };
}

async function openStory(window: Page, id: string) {
  await window.evaluate((story) => {
    location.hash = `#/gallery/${story}`;
  }, id);
  const canvas = window.locator(`[data-story-id="${id}"]`);
  await expect(canvas).toBeVisible();
  return canvas;
}

test("--gallery ouvre le catalogue : stories groupées, sélection, thème sombre", async () => {
  const { app, window } = await launchGallery();
  expect(window.url()).toContain("app://cairn/index.html#/gallery");
  const sidebar = window.getByRole("complementary", { name: "Stories" });
  await expect(sidebar.getByRole("heading", { name: "Buttons" })).toBeVisible();
  await expect(sidebar.getByRole("heading", { name: "Charts" })).toBeVisible();

  await sidebar.getByRole("button", { name: "All badges" }).click();
  await expect(window.locator('[data-story-id="feedback.badge_tones"]')).toBeVisible();
  expect(window.url()).toContain("#/gallery/feedback.badge_tones");

  await window.getByRole("tab", { name: "Dark" }).click();
  await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(window.getByRole("tab", { name: "Dark" })).toHaveAttribute("aria-selected", "true");

  // Contrôles d'une story : changer le libellé du bouton.
  await openStory(window, "buttons.pill");
  await window.getByRole("complementary", { name: "Controls" }).getByRole("textbox", { name: "Text" }).fill("Go");
  await expect(window.locator('[data-story-id="buttons.pill"]').getByRole("button", { name: "Go" })).toBeVisible();
  await app.close();
});

test("un bouton désactivé montre sa raison dans l'infobulle au survol", async () => {
  const { app, window } = await launchGallery();
  const canvas = await openStory(window, "buttons.pill_all");
  const disabled = canvas.locator('button[aria-disabled="true"]:not([aria-busy])').first();
  const reason = "Nothing to verify: this destination has no backup yet.";
  await expect(disabled).toHaveAttribute("aria-description", reason);
  await expect(window.getByRole("tooltip")).toHaveCount(0);
  await disabled.hover();
  await expect(window.getByRole("tooltip")).toHaveText(reason);
  // Un clic sur le bouton désactivé ne fait rien et l'infobulle disparaît quand la souris s'en va.
  await window.mouse.move(2, 2);
  await expect(window.getByRole("tooltip")).toHaveCount(0);
  await app.close();
});

test("le menu de Cairn : clavier, Échap et clic dehors le ferment, destructif en dernier", async () => {
  const { app, window } = await launchGallery();
  const canvas = await openStory(window, "buttons.more_menu");
  const trigger = canvas.getByRole("button", { name: "More" });
  await trigger.click();
  const menu = window.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const items = menu.getByRole("menuitem");
  await expect(items.last()).toHaveText("Delete permanently");
  await expect(items.first()).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();

  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu).toBeVisible();
  await window.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);

  // Clic droit sur une ligne de tableau : le menu de Cairn, jamais un menu natif.
  const table = await openStory(window, "containers.table");
  await table.getByRole("row", { name: /recording\.mov/ }).click({ button: "right" });
  await expect(window.getByRole("menu")).toBeVisible();
  await expect(window.getByRole("menuitem").last()).toHaveText("Move to Trash");
  await window.keyboard.press("Escape");
  await expect(window.getByRole("menu")).toHaveCount(0);
  await app.close();
});

test("--gallery-export n'écrit que dans le dossier demandé", async () => {
  const home = await temporaryHome();
  const sandbox = await temporaryHome();
  const out = path.join(sandbox, "export");
  const { stdout } = await promisify(execFile)(electronBinary, [desktopRoot, "--gallery-export", out], {
    env: isolatedEnv(home),
  });
  expect(stdout).toContain(out);
  expect(await readdir(sandbox)).toEqual(["export"]);
  const files = await readdir(out);
  const images = files.filter((f) => f.endsWith(".png"));
  expect(files.filter((f) => !f.endsWith(".png"))).toEqual(["index.html"]);
  expect(images).toContain("buttons.pill-light.png");
  expect(images).toContain("buttons.pill-dark.png");
  // Une image par story et par thème : autant de clairs que de sombres.
  const light = images.filter((f) => f.endsWith("-light.png")).length;
  expect(light).toBeGreaterThanOrEqual(43);
  expect(images.filter((f) => f.endsWith("-dark.png")).length).toBe(light);
  // Rien dans le dossier de l'utilisateur de test hors du profil Electron.
  expect((await readdir(home)).filter((f) => f !== ".electron")).toEqual([]);
});
