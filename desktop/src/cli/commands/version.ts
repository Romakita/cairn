// `cairn version`, `--version` : `cairn X.Y.Z` (le test de fumée de la release le vérifie).
import { t } from "../../core/l10n.ts";
import { CAIRN_VERSION } from "../../core/version.ts";
import { type CommandEnv, Exit, type ExitCode } from "../shared.ts";

export async function version({ io }: CommandEnv): Promise<ExitCode> {
  io.out(t("cli.version", CAIRN_VERSION));
  return Exit.ok;
}
