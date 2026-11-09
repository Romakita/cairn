// État de l'alimentation (port de `PowerState.current`, Scheduler.swift). Le core lit `pmset` ; le main peut fournir
// sa propre source (`powerMonitor` d'Electron) grâce à l'interface `PowerSource`. L'assertion anti-veille est celle
// du main (`powerSaveBlocker`).
import { run } from "../process.ts";
import { AC_POWER, type Power } from "./schedule.ts";

/** Source de l'état d'alimentation (injectable : `pmset` ici, `powerMonitor` dans le main, valeurs fixes en test). */
export type PowerSource = () => Promise<Power>;

export const PMSET = "/usr/bin/pmset";

/** Sortie de `pmset -g batt` : sur batterie et pourcentage de la première batterie (100 % sans batterie). */
export function parseBattery(output: string): Pick<Power, "onBattery" | "percent"> {
  const onBattery = /Now drawing from 'Battery Power'/.test(output);
  const m = /(\d+)%/.exec(output);
  return { onBattery, percent: m ? Math.min(Number(m[1]), 100) : 100 };
}

/**
 * Sortie de `pmset -g` : mode économie d'énergie actif (`lowpowermode 1`, ou `powermode 1` sur les Mac récents, où
 * 2 est le mode haute performance).
 */
export function parseLowPowerMode(output: string): boolean {
  return /^\s*(lowpowermode|powermode)\s+1\b/m.test(output);
}

/** État courant d'après `pmset` ; secteur si `pmset` ne répond pas. */
export const pmsetPowerSource: PowerSource = async () => {
  const power: Power = { ...AC_POWER };
  try {
    const [batt, settings] = await Promise.all([
      run(PMSET, ["-g", "batt"], { timeoutMs: 5000, stderr: "ignore" }),
      run(PMSET, ["-g"], { timeoutMs: 5000, stderr: "ignore" }),
    ]);
    if (batt.code === 0) Object.assign(power, parseBattery(batt.stdout));
    if (settings.code === 0) power.lowPowerMode = parseLowPowerMode(settings.stdout);
  } catch {
    // pmset absent : secteur
  }
  return power;
};
