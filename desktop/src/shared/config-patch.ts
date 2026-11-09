// Application des patchs typés de la configuration (`saveConfig`), sans aucune dépendance : utilisée par le main
// (avant l'écriture de config.toml) et par l'API d'exemple de l'interface.
import type { CairnConfig } from "../core/config.ts";
import type { ConfigPatch } from "./contract.ts";

/** Copie de `config` avec les patchs appliqués dans l'ordre. */
export function applyPatches(config: CairnConfig, patches: readonly ConfigPatch[]): CairnConfig {
  const c = structuredClone(config);
  for (const p of patches) {
    switch (p.kind) {
      case "language":
        c.language = p.language;
        break;
      case "analysis":
        c.analysis = { ...c.analysis, ...p.analysis };
        break;
      case "folders":
        c.folders = p.folders.map((f) => ({ ...f, exclude: [...f.exclude] }));
        break;
      case "home":
        c.home = { ...c.home, ...p.home };
        break;
      case "ai":
        c.ai = p.ai.map((a) => ({ id: a.id, categories: [...a.categories] }));
        break;
      case "schedule":
        c.schedule = { ...c.schedule, ...p.schedule };
        break;
      case "alerts":
        c.alerts = { ...c.alerts, ...p.alerts };
        break;
      case "git":
        c.git = { ...c.git, ...p.git };
        break;
      case "updates":
        c.checkUpdates = p.check;
        break;
      case "excludedTools":
        c.excludedTools = [...p.excludedTools];
        break;
      case "logRetentionDays":
        c.logRetentionDays = p.days;
        break;
    }
  }
  return c;
}
