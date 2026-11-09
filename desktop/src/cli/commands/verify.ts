// `cairn verify [--full] [--json] [--destination ID] [--version V]` (port de `CLI.verify`). Contrôle les empreintes
// SHA-256 : un échantillon de la dernière version, ou tout (`--full`). Le verrou d'opération est pris et le résultat
// noté dans `runs.json` (`lastVerification`, `damagedVersions`) par `verifyDestination`, comme dans l'app.
// Codes : 2 version inconnue, 1 fichier abîmé, erreur ou verrou tenu.
import { keychainSecrets } from "../../core/backup/secrets.ts";
import { VerifyError, verifyDestination } from "../../core/backup/verify.ts";
import { Fmt } from "../../core/format.ts";
import type { JSONValue } from "../../core/json.ts";
import { t } from "../../core/l10n.ts";
import { OperationLockError } from "../../core/lock.ts";
import { machineName } from "../../core/machine.ts";
import { type CommandEnv, Exit, type ExitCode, errorText, printJSON, readConfig, wantsHelp } from "../shared.ts";

export async function verify({ args, store, io, context }: CommandEnv): Promise<ExitCode> {
  if (wantsHelp(args)) {
    io.out(t("cli.verify.help"));
    return Exit.ok;
  }
  let full = false;
  let json = false;
  let destinationId: string | undefined;
  let version: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--full":
        full = true;
        break;
      case "--json":
        json = true;
        break;
      case "--yes":
      case "-y":
        break; // rien à confirmer
      case "--destination":
      case "--version": {
        const v = args[i + 1];
        if (v === undefined) {
          io.err(t("cli.missing_value", a));
          return Exit.usage;
        }
        i += 1;
        if (a === "--destination") destinationId = v;
        else version = v;
        break;
      }
      default:
        io.err(t("cli.unknown_option", a));
        return Exit.usage;
    }
  }
  const config = await readConfig(store);
  const dests = config.destinations.filter((d) => destinationId === undefined || d.id === destinationId);
  if (dests.length === 0) {
    io.err(t("cli.backup.no_destination"));
    return Exit.usage;
  }
  const overrides = context.backup ?? {};
  const deps = {
    ...overrides,
    secrets: overrides.secrets ?? keychainSecrets,
    machine: overrides.machine ?? (await machineName()),
  };
  let damaged = 0;
  let unknownVersion = false;
  const list: JSONValue[] = [];
  for (const d of dests) {
    try {
      const reports = await verifyDestination(d, store.paths, deps, { version, full });
      for (const r of reports) {
        damaged += r.damaged.length;
        list.push({
          destination: d.id,
          version: r.version,
          checked: r.checked,
          damaged: r.damaged,
          missing_checksums: r.missingChecksums,
          full,
        });
        if (json) continue;
        io.out(
          r.missingChecksums
            ? t("cli.verify.pending", d.id, r.version)
            : t("cli.verify.result", d.id, r.version, Fmt.count(r.checked), r.damaged.length),
        );
        for (const f of r.damaged.slice(0, 20)) io.err(`  ✗ ${f}`);
      }
    } catch (error) {
      if (error instanceof OperationLockError && error.reason === "alreadyHeld") {
        io.err(t("cli.busy"));
        return Exit.failure;
      }
      io.err(errorText(error));
      if (error instanceof VerifyError) {
        unknownVersion = true;
        list.push({ destination: d.id, error: "unknown_version", version: version ?? null });
      } else {
        damaged += 1;
        list.push({ destination: d.id, error: errorText(error) });
      }
    }
  }
  if (json) printJSON({ results: list }, io);
  if (unknownVersion) return Exit.usage;
  return damaged === 0 ? Exit.ok : Exit.failure;
}
