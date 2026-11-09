import { defineConfig } from "@playwright/test";

// Tests de bout en bout : la vraie app Electron (main sous le Node d'Electron), ou l'interface seule (dev:web).
export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
