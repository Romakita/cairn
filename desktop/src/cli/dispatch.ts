/** Commandes qui font passer l'exécutable en mode ligne de commande (même liste que la 0.8.0). */
export const CLI_COMMANDS: ReadonlySet<string> = new Set([
  "analyze",
  "config",
  "tools",
  "ai",
  "git",
  "backup",
  "verify",
  "restore",
  "help",
  "version",
]);

const CLI_FLAGS = new Set(["-h", "--help", "--version", "--lang", "--config"]);

/** Arguments ajoutés par macOS au lancement d'une app (Finder, Launch Services). */
function isSystemArgument(arg: string): boolean {
  return arg.startsWith("-psn_") || arg.startsWith("-NS") || arg.startsWith("-Apple");
}

/**
 * Indique si les arguments (sans l'exécutable) demandent la ligne de commande plutôt que l'interface :
 * le premier argument utile est une commande, ou une option globale.
 */
export function isCommandLine(args: readonly string[]): boolean {
  const first = args.find((a) => !isSystemArgument(a));
  if (first === undefined) return false;
  return CLI_COMMANDS.has(first) || CLI_FLAGS.has(first);
}
