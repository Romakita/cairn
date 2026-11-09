// Régression trouvée en validation réelle (2026-11-09) : sous Electron, le `fs` de Node est patché pour l'asar. Un
// fichier ordinaire `*.asar` (un build Electron sauvegardé par l'utilisateur) y est vu comme un dossier de taille 0
// (archive valide, `open` en EISDIR) ou fait échouer `stat` (« Invalid package »). Les empreintes faisaient échouer
// toute la finalisation de la sauvegarde. Sous Bun le bug n'existe pas : la sonde est bundlée comme l'app
// (scripts/build.ts) et lancée sous le VRAI Node d'Electron (`ELECTRON_RUN_AS_NODE`, fuse ouverte en développement).
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { measure } from "../../src/core/scanner.ts";

const run = promisify(execFile);
const electron = path.resolve(import.meta.dir, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

/** Petite archive asar valide (en-tête Pickle + JSON + contenu), comme le `resources/app.asar` d'un build Electron. */
function asarArchive(): Buffer {
  const json = Buffer.from(JSON.stringify({ files: { "a.txt": { size: 3, offset: "0" } } }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const header = Buffer.alloc(8 + padded.length);
  header.writeUInt32LE(4 + padded.length, 0);
  header.writeUInt32LE(json.length, 4);
  padded.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, Buffer.from("abc"), randomBytes(4000)]);
}

async function sha256(file: string): Promise<string> {
  return (await run("/usr/bin/shasum", ["-a", "256", file])).stdout.split(" ")[0]!;
}

describe.skipIf(!existsSync(electron))("regressions: fs sous Electron", () => {
  test("validation 2026-11-09 : fichier .asar sauvegardé (empreinte, liste et mesure sous le Node d'Electron)", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "cairn-asar-")));
    try {
      const data = path.join(dir, "data");
      const out = path.join(dir, "probe");
      await mkdir(path.join(data, "build/resources"), { recursive: true });
      const files = {
        "build/resources/app.asar": asarArchive(),
        "x.asar": randomBytes(6000 + Math.floor(Math.random() * 4000)), // pas une vraie archive
        "notes.txt": Buffer.from("bonjour\n"),
      };
      for (const [rel, content] of Object.entries(files)) await writeFile(path.join(data, rel), content);

      const built = await Bun.build({
        entrypoints: [path.resolve(import.meta.dir, "../helpers/asar-file-probe.ts")],
        outdir: out,
        target: "node",
        format: "cjs",
        external: ["electron", "original-fs", "*.node"],
        naming: "probe.cjs",
      });
      expect(built.success).toBe(true);

      const asarNames = ["build/resources/app.asar", "x.asar"] as const;
      const { stdout } = await run(electron, [path.join(out, "probe.cjs"), data, ...asarNames], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      const r = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(r.electron).toBeString();
      // Le bug est bien reproduit par le `fs` patché d'Electron : archive vue comme un dossier, l'autre illisible…
      expect(r.asar["build/resources/app.asar"].patched).toBe("directory");
      expect(r.asar["x.asar"].patched).toStartWith("error");
      // … et le core n'y passe plus : fichiers ordinaires, bonne taille, bonne empreinte, bonne mesure.
      for (const name of asarNames) {
        const content = files[name];
        expect(r.asar[name]).toMatchObject({
          isFile: true,
          size: content.length,
          sha256: await sha256(path.join(data, name)),
        });
      }
      const listed = (r.files as { rel: string; size: number }[]).map((f) => [f.rel, f.size]).sort();
      expect(listed).toEqual(
        Object.entries(files)
          .map(([rel, c]) => [rel, c.length])
          .sort(),
      );
      expect(r.measured).toEqual(await measure(data));
      expect(r.measured.size).toBeGreaterThan(files["build/resources/app.asar"].length + files["x.asar"].length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
