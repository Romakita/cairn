// Sauvegardes sur l'interface seule (dev-web, API d'exemple) : page d'une destination, progression à deux
// destinations, raisons d'indisponibilité au survol, menu « … » au clavier, ajout vérifié, suppression, rétention.
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopRoot } from "./helpers.ts";

const PORT = 5195;
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

async function open(scenario = "normal", extra = "", route = "backup"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/?scenario=${scenario}${extra}#/app/${route}`);
  await expect(page.getByTestId("screen-backup")).toBeVisible();
  return page;
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Backups" });

test("page d'une destination : en-tête, chiffres clés, historique ; la sidebar change de destination", async () => {
  const page = await open();
  await expect(page.getByRole("heading", { name: "nas.local", level: 1 })).toBeVisible();
  await expect(page.getByText("smb://nas.local/backups")).toBeVisible();
  await expect(page.getByText("6 backups")).toBeVisible();
  await sidebar(page).getByRole("button", { name: "cairn" }).click();
  await expect(page.getByRole("heading", { name: "cairn", level: 1 })).toBeVisible();
  await expect(page.getByText("/Volumes/Archive/cairn")).toBeVisible();
  await page.close();
});

test("progression : compteurs pendant le comptage, puis finalisation pendant que l'autre copie", async () => {
  const counting = await open("backup-running", "&t=5&frozen=1");
  const nas = counting.getByRole("region", { name: "Backup to nas.local" });
  await expect(nas.getByText(/Counting files: .* found so far \(last backup: 48,200\)/)).toBeVisible();
  await expect(nas.getByText(/^Counter \d · /)).toHaveCount(4);
  await expect(nas.getByText(/Copy · folder 1 of 10/)).toBeVisible();
  await expect(nas.getByRole("listitem").filter({ hasText: "Counting" })).toHaveAttribute("aria-current", "step");
  await expect(
    counting.getByRole("region", { name: "Backup to cairn" }).getByText(/Waiting: the copy to/),
  ).toBeVisible();
  await counting.close();

  const parallel = await open("backup-running", "&t=24&frozen=1");
  await expect(
    parallel.getByRole("region", { name: "Backup to nas.local" }).getByText(/Fingerprinting the new files/),
  ).toBeVisible();
  await expect(
    parallel.getByRole("region", { name: "Backup to cairn" }).getByText(/Copy · folder \d+ of 10/),
  ).toBeVisible();
  // Jamais 100 % avant la fin.
  await expect(parallel.getByText("100 %")).toHaveCount(0);
  await parallel.close();

  const done = await open("backup-running", "&t=40&frozen=1");
  await expect(done.getByRole("region", { name: "Backup finished" })).toBeVisible();
  await expect(done.getByText("version 2026-11-09T100000")).toBeVisible();
  await expect(done.getByRole("button", { name: "View log" })).toBeVisible();
  await done.close();
});

test("« Sauvegarder maintenant » lance la sauvegarde, « Arrêter » l'arrête", async () => {
  const page = await open();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByRole("region", { name: "Backup to nas.local" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("region", { name: "Backup stopped" })).toBeVisible({ timeout: 10_000 });
  await page.close();
});

test("actions indisponibles : désactivées, raison au survol", async () => {
  const page = await open("backup-running", "&t=14&frozen=1");
  const check = page.getByRole("button", { name: "Check integrity" });
  await expect(check).toHaveAttribute("aria-disabled", "true");
  await check.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Unavailable while a backup is running.");
  await page.close();

  const failed = await open("backup-failed", "", "backup/disk");
  const backup = failed.getByRole("button", { name: "Back up now" });
  await expect(backup).toHaveAttribute("aria-disabled", "true");
  await backup.hover();
  await expect(failed.getByRole("tooltip")).toHaveText("The destination isn't reachable.");
  await failed.close();
});

test("menu « … » au clavier : supprimer en rouge et en dernier, Échap ferme", async () => {
  const page = await open();
  await page.getByRole("button", { name: "More actions" }).focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items.last()).toHaveText("Delete destination…");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.close();
});

test("ajout vérifié : type, dossier, vérification, options ; « Ajouter » renvoie à l'étape invalide", async () => {
  const page = await open("normal", "", "backup/add");
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: "Continue" })).toHaveAttribute("aria-disabled", "true");
  await sheet.getByRole("radio", { name: /Folder or disk/ }).click();
  await sheet.getByRole("button", { name: "Continue" }).click();
  await sheet.getByRole("button", { name: "Archive" }).click();
  await sheet.getByRole("button", { name: "Continue" }).click();
  await expect(sheet.getByText(/Destination verified/)).toBeVisible();
  await sheet.getByRole("button", { name: "Continue" }).click();
  // Retour à l'emplacement : un autre dossier invalide la vérification.
  await sheet
    .getByRole("navigation", { name: "Steps" })
    .getByRole("button", { name: /Location/ })
    .click();
  await sheet.getByRole("button", { name: "Photos" }).click();
  await sheet
    .getByRole("navigation", { name: "Steps" })
    .getByRole("button", { name: /Options/ })
    .click();
  await sheet.getByRole("button", { name: "Add" }).click();
  await expect(sheet.getByRole("navigation", { name: "Steps" }).locator('[aria-current="step"]')).toContainText(
    "Check",
  );
  await expect(sheet.getByText(/Destination verified/)).toBeVisible();
  await sheet.getByRole("button", { name: "Continue" }).click();
  await sheet.getByRole("button", { name: "Add" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(sidebar(page).getByRole("button", { name: "Photos" })).toBeVisible();
  await page.close();
});

test("NAS avec l'hôte seul : liste des partages, puis dossier « cairn » dans le partage choisi", async () => {
  const page = await open("normal", "", "backup/add");
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /NAS/ }).click();
  await sheet.getByRole("button", { name: "Continue" }).click();
  await sheet.getByRole("textbox", { name: "Share address" }).fill("smb://nas.local");
  await sheet.getByRole("button", { name: "Connect" }).click();
  await sheet.getByRole("button", { name: "media" }).click();
  await expect(sheet.getByText("smb://nas.local/media/cairn")).toBeVisible();
  await page.close();
});

test("suppression : garder les sauvegardes par défaut, le mot de passe n'est jamais supprimé", async () => {
  const page = await open("normal", "", "backup/disk");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete destination…" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(/Kept: the backups on the destination, the image password/)).toBeVisible();
  await sheet.getByRole("radio", { name: /Also delete/ }).click();
  await expect(sheet.getByRole("button", { name: /^Delete/ })).toHaveAttribute("aria-disabled", "true");
  await sheet.getByRole("button", { name: "Simulate" }).click();
  await expect(sheet.getByRole("button", { name: "Delete with backups (182 GB)" })).toBeVisible();
  await sheet.getByRole("radio", { name: /Keep the backups/ }).click();
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(sidebar(page).getByRole("button", { name: "cairn" })).toHaveCount(0);
  await page.close();
});

test("rétention plus courte : versions supprimées listées avec la taille libérée avant confirmation", async () => {
  const page = await open("normal", "", "backup/disk");
  await page.getByRole("spinbutton", { name: "Versions kept" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "Save" }).click();
  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByRole("heading", { name: /Delete the 2 oldest versions\? 3.4 GB will be freed/ }),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Delete 2 versions" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText("Keep 11 versions")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await page.close();
});

test("mot de passe d'une image neuve : montré une fois, puis oublié", async () => {
  const page = await open("backup-new-image");
  const sheet = page.getByRole("dialog", { name: "Encrypted image created" });
  await expect(sheet.getByText("kV7q-3mXa-PL9w-Z2rT-8hNc")).toBeVisible();
  await sheet.getByRole("button", { name: "I wrote it down" }).click();
  await expect(sheet).toHaveCount(0);
  await page.close();
});

test("« Ajouter une destination » sans destination ouvre le formulaire", async () => {
  const page = await open("empty");
  await expect(page.getByRole("heading", { name: "No destination" })).toBeVisible();
  await page.getByRole("button", { name: "Add a destination" }).last().click();
  await expect(page.getByRole("dialog", { name: "Add a destination" })).toBeVisible();
  await page.close();
});

test("sans l'Accès complet au disque : bandeau et éléments refusés dans le résultat", async () => {
  const page = await open("no-full-disk-access", "&frozen=1&lang=fr");
  await expect(page.getByTestId("full-disk-access")).toContainText(
    "Cairn n'a pas l'Accès complet au disque : Documents, Téléchargements",
  );
  const result = page.getByRole("region", { name: "Sauvegarde terminée" });
  await expect(result.getByText("21 éléments n'ont pas pu être lus")).toBeVisible();
  await expect(result.getByText("/Users/demo/Documents", { exact: true })).toBeVisible();
  await expect(result.getByText("…et 16 autres, listés dans le journal.")).toBeVisible();
  // Un seul lien vers le journal, dans le bandeau des éléments refusés.
  await expect(result.getByRole("button", { name: "Voir le journal" })).toHaveCount(1);
  await page.getByRole("button", { name: "Ouvrir les réglages" }).click();
  await expect(page.getByTestId("full-disk-access")).toHaveCount(0);
  await page.close();
});
