// Nom de la machine et architecture (port de `BackupEngine.machineName()` et de `Updater.arch`).
// Le nom doit rester celui de la 0.8.0 : il nomme l'image (`cairn-<machine>.sparsebundle`), le dossier des versions
// et le compte du mot de passe d'image dans le Trousseau.
import { execFile } from "node:child_process";
import os from "node:os";

/** Même transformation que la 0.8.0 : tout caractère hors `[A-Za-z0-9._-]` devient `-` (un par scalaire). */
export function sanitizeMachineName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/gu, "-");
}

/** `scutil --get ComputerName` (nom de l'ordinateur, comme `Host.current().localizedName`), ou `null`. */
export type ComputerNameReader = () => Promise<string | null>;

export const readComputerName: ComputerNameReader = () =>
  new Promise((resolve) => {
    execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
      const name = error ? "" : stdout.trim();
      resolve(name ? name : null);
    });
  });

/** Nom brut puis nettoyé ; repli sur le nom d'hôte, comme `ProcessInfo.hostName`. */
export async function resolveMachineName(read: ComputerNameReader = readComputerName): Promise<string> {
  const name = (await read()) ?? os.hostname();
  return sanitizeMachineName(name);
}

let cached: Promise<string> | null = null;

/** Nom de cette machine, lu une fois puis gardé en cache. */
export function machineName(): Promise<string> {
  cached ??= resolveMachineName();
  return cached;
}

/** Remplace le nom en cache (tests) ; `null` le fait relire. */
export function setMachineName(name: string | null): void {
  cached = name === null ? null : Promise.resolve(name);
}

export type Arch = "arm64" | "x86_64";

/** Architecture de la machine : `arm64` ou `x86_64` (noms des archives de release). */
export function arch(machine: string = os.machine()): Arch {
  return machine === "arm64" || machine === "aarch64" ? "arm64" : "x86_64";
}
