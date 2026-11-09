// Ligne de commande par le vrai exécutable Electron (`electron <desktop> <args>`) : mêmes sorties que `runCli`,
// sans fenêtre et sans bruit de Chromium sur stdout ni sur stderr.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { runCairn, temporaryHome } from "./helpers.ts";

/** Lignes qu'Electron ou Chromium pourraient ajouter (journaux `[1234:…:ERROR:…]`, avertissements, DevTools). */
const NOISE = /^\[\d+:\d+\/|ERROR:|WARNING:|DevTools|Electron|objc\[/m;

test("--help in English and French (--lang)", async () => {
  const home = await temporaryHome();
  const en = await runCairn(["--help", "--lang", "en-US"], home);
  expect(en.code).toBe(0);
  expect(en.stdout.startsWith("Cairn — storage analysis")).toBe(true);
  expect(en.stdout).toContain("Commands:");
  expect(en.stderr).toBe("");
  const fr = await runCairn(["--lang", "fr-FR", "--help"], home);
  expect(fr.code).toBe(0);
  expect(fr.stdout).toContain("Commandes :");
  expect(fr.stderr).toBe("");
});

test("analyze --json writes valid JSON only on stdout", async () => {
  const home = await temporaryHome();
  const folder = path.join(home, "data");
  await mkdir(path.join(folder, "node_modules/x"), { recursive: true });
  await writeFile(path.join(folder, "node_modules/x/index.js"), Buffer.alloc(100_000));
  await writeFile(path.join(folder, "big.bin"), Buffer.alloc(300_000));
  const r = await runCairn(["analyze", folder, "--json"], home);
  expect(r.code).toBe(0);
  const obj = JSON.parse(r.stdout) as { folders: Array<{ path: string; size: number; breakdown: { deps: number } }> };
  expect(obj.folders).toHaveLength(1);
  expect(obj.folders[0]?.path).toBe(folder);
  expect(obj.folders[0]?.size).toBeGreaterThanOrEqual(400_000);
  expect(obj.folders[0]?.breakdown.deps).toBeGreaterThanOrEqual(100_000);
  expect(r.stdout).not.toMatch(NOISE);
  expect(r.stderr).toBe("");
});

test("unknown command: help on stderr and code 2", async () => {
  const home = await temporaryHome();
  // Une option globale d'abord : un premier argument inconnu ouvrirait l'interface (même aiguillage que la 0.8.0).
  const r = await runCairn(["--lang", "en-US", "frobnicate"], home);
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr.startsWith("Unknown command: frobnicate\n")).toBe(true);
  expect(r.stderr).not.toMatch(NOISE);
});

test("config path --json and version: clean stdout", async () => {
  const home = await temporaryHome();
  const file = path.join(home, "c.toml");
  await writeFile(file, 'version = 1\nlanguage = "fr-FR"\n');
  const r = await runCairn(["config", "path", "--json", "--config", file], home);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`{\n  "exists" : true,\n  "path" : "${file.replaceAll("/", "\\/")}"\n}\n`);
  expect(r.stderr).toBe("");
  const v = await runCairn(["version"], home);
  expect(v.stdout).toMatch(/^cairn \d+\.\d+\.\d+\n$/);
  expect(v.stderr).toBe("");
});

test("backup --dry-run --json and an unknown tool through the app executable (temporary destination)", async () => {
  const home = await temporaryHome();
  const src = path.join(home, "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "a.bin"), Buffer.alloc(20_000));
  const cfg = path.join(home, "config.toml");
  await writeFile(
    cfg,
    `version = 1\n[[folders]]\npath = "${src}"\n[[destinations]]\nid = "local"\nprovider = "local"\npath = "${home}/dest"\nencrypted = false\n`,
  );
  const r = await runCairn(["backup", "--dry-run", "--only", "folders", "--json", "--config", cfg], home);
  expect(r.code).toBe(0);
  const [result] = (JSON.parse(r.stdout) as { results: Array<{ dry_run: boolean; files_transferred: number }> })
    .results;
  expect(result?.dry_run).toBe(true);
  expect(result?.files_transferred).toBe(1);
  expect(r.stderr).not.toMatch(NOISE);
  const unknown = await runCairn(["backup", "--tool", "nope", "--config", cfg, "--lang", "en-US"], home);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("Unknown AI tool: nope");
});
