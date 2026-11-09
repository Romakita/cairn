import { CAIRN_VERSION } from "../core/version.ts";

/** Codes de sortie de la ligne de commande. */
export const Exit = { ok: 0, failure: 1, usage: 2 } as const;
export type ExitCode = (typeof Exit)[keyof typeof Exit];

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

/** Exécute une commande (arguments sans l'exécutable) et renvoie le code de sortie. */
export async function runCli(args: readonly string[], io: CliIO): Promise<ExitCode> {
  const [command] = args;
  if (command === "version" || command === "--version") {
    io.out(`cairn ${CAIRN_VERSION}`);
    return Exit.ok;
  }
  io.err(`cairn: ${command ?? ""}: not available yet`);
  return Exit.usage;
}
