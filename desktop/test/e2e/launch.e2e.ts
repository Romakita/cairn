import { expect, test } from "@playwright/test";
import { launchApp, runCairn, temporaryHome } from "./helpers.ts";

test("l'interface s'ouvre isolée du système (sandbox, pas de Node)", async () => {
  const app = await launchApp(await temporaryHome());
  const window = await app.firstWindow();
  await expect(window.getByTestId("app-root")).toBeAttached();
  const isolation = await window.evaluate(() => ({
    hasProcess: typeof (globalThis as { process?: unknown }).process !== "undefined",
    hasRequire: typeof (globalThis as { require?: unknown }).require !== "undefined",
    hasCairn: typeof (globalThis as { cairn?: unknown }).cairn === "object",
    origin: location.origin,
  }));
  expect(isolation).toEqual({ hasProcess: false, hasRequire: false, hasCairn: true, origin: "app://cairn" });
  const sandboxed = await app.evaluate(({ BrowserWindow }) => {
    type WithPrefs = { getLastWebPreferences(): Electron.WebPreferences };
    const contents = BrowserWindow.getAllWindows()[0]?.webContents as unknown as WithPrefs | undefined;
    const prefs = contents?.getLastWebPreferences();
    return {
      sandbox: prefs?.sandbox,
      contextIsolation: prefs?.contextIsolation,
      nodeIntegration: prefs?.nodeIntegration,
    };
  });
  expect(sandboxed).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  await app.close();
});

test("la commande répond pendant que l'app est ouverte", async () => {
  const home = await temporaryHome();
  const app = await launchApp(home);
  await app.firstWindow();
  const result = await runCairn(["--version"], home);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/^cairn \d+\.\d+\.\d+\n$/);
  expect(await app.windows()).toHaveLength(1);
  await app.close();
});
