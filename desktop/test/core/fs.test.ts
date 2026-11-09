// src/core/fs.ts et fs-promises.ts : hors d'Electron (bun test), exactement `node:fs` et `node:fs/promises`.
// Le cas Electron (`original-fs`) est couvert par test/regressions/electron-fs.test.ts, sous le vrai Node d'Electron.
import { describe, expect, test } from "bun:test";
import nodeFsDefault, * as nodeFs from "node:fs";
import nodeFsPromisesDefault, * as nodeFsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as fsModule from "../../src/core/fs.ts";
import * as fsPromisesModule from "../../src/core/fs-promises.ts";

describe("fs", () => {
  /** Exports de `ours` comparés à ceux de `reference` (même objet, nom par nom). */
  function sameExports(ours: Record<string, unknown>, reference: Record<string, unknown>, own: string): string[] {
    const names = Object.keys(ours).filter((k) => k !== own);
    for (const name of names) expect([name, ours[name]]).toEqual([name, reference[name]]);
    return names;
  }

  test("hors d'Electron, chaque export est celui de node:fs", () => {
    expect(fsModule.fs).toBe(nodeFsDefault);
    expect(sameExports({ ...fsModule }, { ...nodeFs }, "fs").length).toBeGreaterThan(80);
  });

  test("hors d'Electron, chaque export de fs-promises est celui de node:fs/promises", () => {
    expect(fsPromisesModule.fsPromises).toBe(nodeFsPromisesDefault);
    expect(sameExports({ ...fsPromisesModule }, { ...nodeFsPromises }, "fsPromises").length).toBeGreaterThan(25);
  });

  test("un fichier .asar est un fichier ordinaire (stat, lecture, liste)", async () => {
    const dir = await fsPromisesModule.mkdtemp(path.join(os.tmpdir(), "cairn-fs-"));
    try {
      const file = path.join(dir, "app.asar");
      await fsPromisesModule.writeFile(file, Buffer.alloc(3000, 7));
      const st = await fsPromisesModule.stat(file);
      expect([st.isFile(), st.size]).toEqual([true, 3000]);
      expect((await fsPromisesModule.readFile(file)).length).toBe(3000);
      const entries = await fsPromisesModule.readdir(dir, { withFileTypes: true });
      expect(entries.map((e) => [e.name, e.isFile()])).toEqual([["app.asar", true]]);
      expect(fsModule.statSync(file).isDirectory()).toBe(false);
    } finally {
      await fsPromisesModule.rm(dir, { recursive: true, force: true });
    }
  });
});
