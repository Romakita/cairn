// `cairn help`, `-h`, `--help` : aide générale.
import { t } from "../../core/l10n.ts";
import { type CommandEnv, Exit, type ExitCode } from "../shared.ts";

export async function help({ io }: CommandEnv): Promise<ExitCode> {
  io.out(t("cli.help"));
  return Exit.ok;
}
