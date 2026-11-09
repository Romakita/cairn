// `cairn tools [--json] [--export DIR]` (port de `CLI.tools`) : inventaire des outils en ligne de commande.
// Le JSON a des codes stables (`{"code":"history","uses":5}`) : la langue ne change que la sortie texte.
import { collect } from "../../core/inventory/collector.ts";
import { inventoryJSON, writeInventory } from "../../core/inventory/export.ts";
import { type InventoryStatus, reasonText, retainedTools } from "../../core/inventory/types.ts";
import { t } from "../../core/l10n.ts";
import { expandTilde } from "../../core/paths.ts";
import { type CommandEnv, Exit, type ExitCode, errorText, pad, readConfig, wantsHelp } from "../shared.ts";

const GROUPS: readonly InventoryStatus[] = ["missing", "used", "unused"];

export async function tools({ args, store, io }: CommandEnv): Promise<ExitCode> {
  if (wantsHelp(args)) {
    io.out(t("cli.tools.help"));
    return Exit.ok;
  }
  let json = false;
  let exportDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--json":
        json = true;
        break;
      case "--yes":
      case "-y":
        break; // rien à confirmer
      case "--export": {
        const v = args[i + 1];
        if (v === undefined) {
          io.err(t("cli.missing_value", "--export"));
          return Exit.usage;
        }
        exportDir = expandTilde(v);
        i += 1;
        break;
      }
      default:
        io.err(t("cli.unknown_option", a));
        return Exit.usage;
    }
  }
  const inv = await collect(await readConfig(store));
  if (exportDir !== null) {
    try {
      await writeInventory(inv, exportDir);
    } catch (error) {
      io.err(errorText(error));
      return Exit.failure;
    }
    io.err(t("cli.tools.exported", retainedTools(inv).length, exportDir));
  }
  if (json) {
    io.out(inventoryJSON(inv));
  } else if (exportDir === null) {
    for (const status of GROUPS) {
      const group = inv.entries.filter((e) => e.status === status);
      if (group.length === 0) continue;
      io.out(`${t(`inventory.status.${status}`)} (${group.length})`);
      for (const e of group) {
        const source = e.tool?.source ?? "—";
        const version = e.tool?.version ?? "";
        const mark = e.excluded ? " ✗" : "";
        io.out(
          `  ${pad(e.name, 28)} ${pad(source, 10)} ${pad(version, 12)} ${e.reasons.map(reasonText).join(", ")}${mark}`,
        );
      }
    }
  }
  return Exit.ok;
}
