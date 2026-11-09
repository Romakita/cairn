// `cairn config path|show|validate [--json]` (port de `CLI.config`).
// `path` et `show` ne modifient rien ; `validate` charge le fichier comme l'app, donc migre un ancien fichier
// (copie `config.toml.bak`).
import {
  type CairnConfig,
  type ConfigIssue,
  defaultConfig,
  newConfigDocument,
  type Retention,
} from "../../core/config.ts";
import type { ConfigStore } from "../../core/config-store.ts";
import type { JSONValue } from "../../core/json.ts";
import { t } from "../../core/l10n.ts";
import { type CommandEnv, Exit, type ExitCode, errorText, printJSON } from "../shared.ts";

/** Problèmes en JSON : le message est celui affiché, les autres champs sont des identifiants. */
export function issuesJSON(issues: readonly ConfigIssue[]): JSONValue {
  return issues.map((i) => ({ severity: i.severity, key: i.key, line: i.line, message: i.message }));
}

function retentionJSON(r: Retention): JSONValue {
  return r.mode === "tiered" ? { kind: "tiered", days: r.days, weeks: r.weeks } : { kind: "count", versions: r.count };
}

/** Configuration complète en JSON, mêmes noms que `config.toml` (`CLI.configJSON`). */
export function configJSON(c: CairnConfig): JSONValue {
  return {
    version: c.version,
    language: c.language,
    analysis: {
      big_file_threshold_mb: c.analysis.bigFileThresholdMB,
      big_folder_threshold_gb: c.analysis.bigFolderThresholdGB,
    },
    folders: c.folders.map((f) => ({ path: f.path, backup: f.backup, exclude: f.exclude })),
    home: { include: c.home.include, exclude: c.home.exclude },
    ai: c.ai.map((a) => ({ id: a.id, categories: a.categories })),
    destinations: c.destinations.map((d) => ({
      id: d.id,
      provider: d.provider,
      path: d.path ?? null,
      url: d.url ?? null,
      username: d.username ?? null,
      keychain: d.keychain ?? null,
      encrypted: d.encrypted,
      retention: retentionJSON(d.retention),
    })),
    schedule: {
      frequency: c.schedule.frequency,
      time: c.schedule.time,
      weekday: c.schedule.weekday,
      background: c.schedule.background,
      on_battery_min_percent: c.schedule.onBatteryMinPercent,
    },
    alerts: {
      low_percent: c.alerts.lowPercent,
      low_gb: c.alerts.lowGB,
      critical_percent: c.alerts.criticalPercent,
      critical_gb: c.alerts.criticalGB,
    },
    logs: { retention_days: c.logRetentionDays },
    updates: { check: c.checkUpdates },
    git: { fetch_before: c.git.fetchBefore, gc: c.git.gc, worktree_stale_days: c.git.worktreeStaleDays },
    tools: { excluded: c.excludedTools },
  };
}

async function show(store: ConfigStore, json: boolean, env: CommandEnv): Promise<ExitCode> {
  const { io } = env;
  const exists = await store.exists();
  let config = defaultConfig();
  let issues: ConfigIssue[] = [];
  if (exists) {
    try {
      const loaded = await store.load();
      config = loaded.config;
      issues = loaded.issues;
      if (!json) for (const i of loaded.issues) io.err(i.description);
    } catch (error) {
      io.err(errorText(error));
      return Exit.usage;
    }
  } else if (!json) {
    io.err(t("cli.config.defaults"));
  }
  if (json) printJSON({ path: store.file, exists, config: configJSON(config), issues: issuesJSON(issues) }, io);
  else io.out(newConfigDocument(config).render());
  return Exit.ok;
}

async function validate(store: ConfigStore, json: boolean, env: CommandEnv): Promise<ExitCode> {
  const { io } = env;
  const bak = `${store.file}.bak`;
  if (!(await store.exists())) {
    if (json) printJSON({ path: store.file, exists: false, valid: false, issues: [] }, io);
    else io.err(t("cli.config.missing", store.file));
    return Exit.usage;
  }
  try {
    const loaded = await store.load();
    if (json) {
      printJSON(
        {
          path: store.file,
          exists: true,
          valid: !loaded.hasErrors,
          migrated: loaded.migrated,
          backup: loaded.migrated ? bak : null,
          issues: issuesJSON(loaded.issues),
        },
        io,
      );
      return loaded.hasErrors ? Exit.usage : Exit.ok;
    }
    if (loaded.migrated) io.err(t("cli.config.migrated", bak));
    for (const i of loaded.issues) io.err(i.description);
    if (loaded.hasErrors) return Exit.usage;
    io.out(t("cli.config.valid", store.file));
    return Exit.ok;
  } catch (error) {
    if (json) printJSON({ path: store.file, exists: true, valid: false, error: errorText(error) }, io);
    else io.err(errorText(error));
    return Exit.usage;
  }
}

export async function config(env: CommandEnv): Promise<ExitCode> {
  const { args, store, io } = env;
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help") {
    io.out(t("cli.config.help"));
    return Exit.ok;
  }
  let json = false;
  for (const a of rest) {
    switch (a) {
      case "--json":
        json = true;
        break;
      case "--yes":
      case "-y":
        break; // rien à confirmer
      case "-h":
      case "--help":
        io.out(t("cli.config.help"));
        return Exit.ok;
      default:
        io.err(t("cli.unknown_option", a));
        return Exit.usage;
    }
  }
  switch (sub) {
    case "path":
      if (json) printJSON({ path: store.file, exists: await store.exists() }, io);
      else io.out(store.file);
      return Exit.ok;
    case "show":
      return show(store, json, env);
    case "validate":
      return validate(store, json, env);
    default:
      io.err(t("cli.unknown_command", `config ${sub}`));
      io.err(t("cli.config.help"));
      return Exit.usage;
  }
}
