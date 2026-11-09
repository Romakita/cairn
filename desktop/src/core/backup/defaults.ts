// Branchement des vraies capacités sur le service de sauvegarde (équivalent de `CLI.aiParts` et des valeurs par
// défaut de `BackupService`) : classement régénérable, inventaire des outils, parties IA, rétention, Trousseau.
// L'app (main) et `cairn backup` partent de là et ajoutent ce qui leur est propre (veille, relevé du disque…).
import os from "node:os";
import { type AIProfile, aiParts, BUNDLED_PROFILES, homePaths, openToolsLogLine } from "../ai/index.ts";
import { collect, writeInventory } from "../inventory/index.ts";
import { excludesForFolder, HOME_EXCLUDES, homeItems } from "../regenerable.ts";
import { keepVersions } from "../retention.ts";
import type { BackupServiceDependencies, RegenerableRules } from "./run.ts";
import { keychainSecrets } from "./secrets.ts";

/** Règles régénérables de `regenerable.ts` (les mêmes que l'analyse). */
export function regenerableRules(profiles: readonly AIProfile[] = BUNDLED_PROFILES): RegenerableRules {
  return {
    async forFolder(folder, options) {
      const controller = new AbortController();
      const timer = setInterval(() => {
        if (options.isCancelled()) controller.abort();
      }, 100);
      timer.unref?.();
      try {
        return await excludesForFolder(folder, options.userPatterns, options.destinations, {
          signal: controller.signal,
          visiting: options.onDir,
        });
      } finally {
        clearInterval(timer);
      }
    },
    homeItems(include, home) {
      return homeItems(
        include,
        home,
        profiles.map((p) => ({ homePaths: homePaths(p) })),
      );
    },
    homeExcludes: HOME_EXCLUDES,
  };
}

/** Dépendances réelles du service ; `overrides` remplace ce qu'il faut (tests, main). */
export function defaultBackupDependencies(
  overrides: Partial<BackupServiceDependencies> = {},
): BackupServiceDependencies {
  // Le home vaut pour toutes les parties, IA comprise : un home remplacé (tests, --config) ne lit jamais le vrai `~`.
  const home = overrides.home ?? os.homedir();
  return {
    regenerable: regenerableRules(),
    home,
    secrets: keychainSecrets,
    retentionKeep: keepVersions,
    exportInventory: async (config, dir) => writeInventory(await collect(config), dir),
    aiParts: ({ config, staging, tools, warn }) =>
      aiParts(tools ? { ...config, ai: config.ai.filter((a) => tools.includes(a.id)) } : config, staging, {
        warn,
        home,
      }),
    openToolsLogLine: (config) => openToolsLogLine(config),
    ...overrides,
  };
}
