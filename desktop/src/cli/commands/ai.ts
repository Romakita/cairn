// `cairn ai [--json]` (port de `CLI.ai`) : outils IA détectés, taille par catégorie, catégories retenues.
// Lecture seule du home ; rien n'est copié ni modifié.

import { displayName } from "../../core/ai/profiles.ts";
import { aiJSON, allToolStats } from "../../core/ai/stats.ts";
import { AI_CATEGORIES } from "../../core/config.ts";
import { Fmt } from "../../core/format.ts";
import { t } from "../../core/l10n.ts";
import { type CommandEnv, Exit, type ExitCode, pad, readConfig, wantsHelp } from "../shared.ts";

export async function ai({ args, store, io }: CommandEnv): Promise<ExitCode> {
  if (wantsHelp(args)) {
    io.out(t("cli.ai.help"));
    return Exit.ok;
  }
  let json = false;
  for (const a of args) {
    switch (a) {
      case "--json":
        json = true;
        break;
      case "--yes":
      case "-y":
        break; // rien à confirmer
      default:
        io.err(t("cli.unknown_option", a));
        return Exit.usage;
    }
  }
  const config = await readConfig(store);
  const stats = await allToolStats();
  if (json) {
    io.out(aiJSON(stats, config));
    return Exit.ok;
  }
  for (const s of stats) {
    const selected = config.ai.find((a) => a.id === s.profile.id)?.categories ?? [];
    io.out(`${displayName(s.profile)} — ${s.detected ? Fmt.bytes(s.totalBytes) : t("onboarding.ai.not_detected")}`);
    if (!s.detected) continue;
    for (const cat of AI_CATEGORIES) {
      if ((s.profile.categories[cat] ?? []).length === 0) continue;
      const mark = selected.includes(cat) ? "✓ " : "  ";
      io.out(`  ${mark}${pad(t(`ai.category.${cat}`), 18)}${Fmt.bytes(s.bytesByCategory[cat] ?? 0)}`);
    }
    if (s.conversations > 0) {
      const latest = s.latestConversation ? Fmt.date(s.latestConversation) : "—";
      io.out(`  ${t("cli.ai.conversations", s.conversations, latest)}`);
    }
    if (s.notCopiedBytes > 0) io.out(`  ${t("cli.ai.not_copied", Fmt.bytes(s.notCopiedBytes))}`);
    if (s.profile.credentials_in_keychain) io.out(`  ${t("cli.ai.keychain")}`);
  }
  return Exit.ok;
}
