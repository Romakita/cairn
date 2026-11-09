// Mode ligne de commande de l'exécutable Cairn (port de `CLI.run`, CLI.swift). Une commande par fichier dans
// `commands/` ; ici, les options globales (`--config`, `--lang`) et l'aiguillage.
import path from "node:path";
import { ConfigStore } from "../core/config-store.ts";
import { configureLanguage, parseLanguageSetting, t } from "../core/l10n.ts";
import { ai } from "./commands/ai.ts";
import { analyze } from "./commands/analyze.ts";
import { backup } from "./commands/backup.ts";
import { config } from "./commands/config.ts";
import { git } from "./commands/git.ts";
import { help } from "./commands/help.ts";
import { restore } from "./commands/restore.ts";
import { tools } from "./commands/tools.ts";
import { verify } from "./commands/verify.ts";
import { version } from "./commands/version.ts";
import { type CliContext, type CliIO, type Command, configuredLanguage, Exit, type ExitCode } from "./shared.ts";

export type { CliContext, CliIO, ExitCode } from "./shared.ts";
export { Exit } from "./shared.ts";

/** Commandes (même liste que `CLI_COMMANDS` de dispatch.ts, plus les alias de l'aide et de la version). */
const COMMANDS: Readonly<Record<string, Command>> = {
  help,
  "-h": help,
  "--help": help,
  version,
  "--version": version,
  analyze,
  config,
  tools,
  ai,
  git,
  backup,
  verify,
  restore,
};

/** Contexte de l'app empaquetée ou de `electron .` : `appPath` est `app.getAppPath()`. */
export function cliContextForApp(appPath: string, preferredLanguages?: readonly string[]): CliContext {
  return { gitWorkerFile: path.join(appPath, "dist/git-worker.cjs"), preferredLanguages };
}

/** Retire `name VALEUR` des arguments ; `undefined` si l'option est absente, `null` si sa valeur manque. */
function takeOption(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined) return null;
  args.splice(i, 2);
  return value;
}

/** Exécute une commande (arguments sans l'exécutable) et renvoie le code de sortie. */
export async function runCli(argv: readonly string[], io: CliIO, context: CliContext = {}): Promise<ExitCode> {
  const args = [...argv];
  const languages = context.preferredLanguages;

  // --config FICHIER : l'état, les journaux et le verrou vivent à côté de ce fichier.
  const configPath = takeOption(args, "--config");
  if (configPath === null) {
    io.err(t("cli.missing_value", "--config"));
    return Exit.usage;
  }
  const store = configPath === undefined ? new ConfigStore() : ConfigStore.forConfigFile(configPath);
  // `~/.cairn` (ou `$CAIRN_HOME`) en 700 avant toute écriture. Le dossier d'un --config n'est pas modifié.
  if (configPath === undefined) await store.paths.ensure().catch(() => {});

  // --lang prime sur la langue de config.toml pour cette exécution ; une langue invalide est une erreur d'usage.
  const lang = takeOption(args, "--lang");
  if (lang === null) {
    io.err(t("cli.missing_value", "--lang"));
    return Exit.usage;
  }
  if (lang !== undefined && parseLanguageSetting(lang) === undefined) {
    configureLanguage(null, languages);
    io.err(t("cli.invalid_lang", lang));
    return Exit.usage;
  }
  configureLanguage(lang ?? (await configuredLanguage(store)), languages);

  const [command, ...rest] = args;
  if (command === undefined) {
    io.out(t("cli.help"));
    return Exit.ok;
  }
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (run) return run({ args: rest, store, io, context });
  io.err(t("cli.unknown_command", command));
  io.err(t("cli.help"));
  return Exit.usage;
}
