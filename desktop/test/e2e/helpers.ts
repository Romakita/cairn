import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type ElectronApplication, _electron as electron } from "@playwright/test";

export const desktopRoot = path.resolve(import.meta.dirname, "../..");
const electronBinary = path.join(desktopRoot, "node_modules/.bin/electron");

/** Dossier `CAIRN_HOME` vide, propre à un test. */
export async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cairn-e2e-"));
}

/** Lance l'interface construite (dist/) avec un `CAIRN_HOME` isolé. */
export async function launchApp(cairnHome: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [desktopRoot],
    cwd: desktopRoot,
    env: { ...process.env, CAIRN_HOME: cairnHome, CAIRN_E2E_USER_DATA: path.join(cairnHome, ".electron") },
  });
}

/** Lance l'exécutable en ligne de commande et renvoie sa sortie et son code. */
export async function runCairn(
  args: string[],
  cairnHome: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(electronBinary, [desktopRoot, ...args], {
      env: { ...process.env, CAIRN_HOME: cairnHome },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}
