// `cairn backup [--dry-run] [--json] [--destination ID]… [--only folders|home|tools|ai]… [--tool ID]…`
// (port de `CLI.backup` et `CLI.runBackup`). Toute erreur d'usage ou de configuration (code 2) est détectée AVANT la
// moindre écriture ; le verrou d'opération (pris par `BackupService`) refuse une 2ᵉ opération (`cli.busy`, code 1).
// Progression : une ligne sur stderr par point de pourcentage, une seule pendant le comptage.
// Accès complet au disque : refusé → avertissement sur stderr avant de commencer (hors --json), puis une ligne par
// destination pour les éléments que macOS n'a pas laissé lire ; en --json, `full_disk_access` et `permission_denied`.
import os from "node:os";
import { BUNDLED_PROFILES } from "../../core/ai/profiles.ts";
import { defaultBackupDependencies } from "../../core/backup/defaults.ts";
import type { DestinationProgress } from "../../core/backup/progress.ts";
import { type BackupRequest, type BackupResult, BackupService } from "../../core/backup/run.ts";
import type { PartKind } from "../../core/backup/types.ts";
import { Fmt } from "../../core/format.ts";
import { type FullDiskAccess, fullDiskAccess } from "../../core/full-disk-access.ts";
import type { JSONValue } from "../../core/json.ts";
import { t } from "../../core/l10n.ts";
import { OperationLockError } from "../../core/lock.ts";
import { type CliIO, type CommandEnv, Exit, type ExitCode, errorText, pad, printJSON, wantsHelp } from "../shared.ts";

const ONLY: Readonly<Record<string, PartKind>> = { folders: "folder", home: "home", tools: "tools", ai: "ai" };

function resultJSON(r: BackupResult): JSONValue {
  const d: Record<string, JSONValue> = {
    destination: r.destination,
    waiting: r.waiting,
    error: r.error,
    damaged_files: r.damagedFiles,
    permission_denied: { count: r.permissionDenied.count, examples: r.permissionDenied.examples },
    log: r.log,
  };
  if (r.imageCheck) d.image_check_ok = r.imageCheck.ok;
  const o = r.outcome;
  if (o) {
    d.version = o.version;
    d.dry_run = o.dryRun;
    d.bytes_by_part = o.bytesByPart;
    d.files_transferred = o.filesTransferred;
    d.bytes_transferred = o.bytesTransferred;
    d.deleted_versions = o.deletedVersions;
    d.warnings = o.warnings;
  }
  return d;
}

function printResults(results: readonly BackupResult[], io: CliIO): void {
  for (const r of results) {
    const o = r.outcome;
    if (o) {
      io.out(
        o.dryRun
          ? t("cli.backup.dry_result", r.destination, Fmt.count(o.filesTransferred), Fmt.bytes(o.bytesTransferred))
          : t(
              "cli.backup.result",
              r.destination,
              o.version ?? "-",
              Fmt.count(o.filesTransferred),
              Fmt.bytes(o.bytesTransferred),
              Fmt.duration(o.duration),
            ),
      );
      for (const part of Object.keys(o.bytesByPart).sort()) {
        io.out(`  ${pad(part, 30)} ${Fmt.bytes(o.bytesByPart[part] ?? 0)}`);
      }
      for (const w of o.warnings) io.err(`  ${w}`);
      if (r.damagedFiles.length > 0) {
        io.err(t("cli.backup.damaged", r.damagedFiles.length));
        for (const f of r.damagedFiles.slice(0, 20)) io.err(`  ✗ ${f}`);
      }
      if (r.permissionDenied.count > 0) {
        io.err(t("cli.backup.permission_denied", r.destination, Fmt.count(r.permissionDenied.count)));
        for (const p of r.permissionDenied.examples) io.err(`  ✗ ${p}`);
      }
      if (r.imageCheck && !r.imageCheck.ok)
        io.err(t("cli.backup.image_check_failed", r.destination, r.imageCheck.output));
      if (o.deletedVersions.length > 0) io.out(t("cli.backup.deleted", o.deletedVersions.length));
    } else if (r.waiting) {
      io.err(t("cli.backup.waiting", r.destination));
    } else {
      io.err(t("cli.backup.failed", r.destination, r.error ?? ""));
    }
    // Mot de passe d'une image chiffrée neuve : affiché une seule fois, ici.
    if (r.newImagePassword) io.out(t("cli.backup.image_password", r.destination, r.newImagePassword));
  }
}

/** Une ligne par point de pourcentage et par destination ; une seule ligne pendant le comptage. */
function progressPrinter(io: CliIO): (p: DestinationProgress) => void {
  const last = new Map<string, number>();
  const counted = new Set<string>();
  return (p) => {
    if (p.phase === "counting" && !counted.has(p.destination)) {
      counted.add(p.destination);
      io.err(t("cli.backup.counting", p.destination));
    }
    // La copie commence pendant le comptage : son pourcentage s'affiche dès qu'il existe, même si la phase reste
    // « comptage » (une petite copie peut finir avant la fin du comptage).
    const c = p.copy;
    if ((p.phase !== "counting" && p.phase !== "copying") || !c || c.percent === null) return;
    if (last.get(p.destination) === c.percent) return;
    last.set(p.destination, c.percent);
    io.err(
      t(
        "cli.backup.progress_percent",
        p.destination,
        c.part,
        c.percent,
        Fmt.count(c.processed),
        Fmt.count(c.expected ?? 0),
      ),
    );
  };
}

export async function backup({ args, store, io, context }: CommandEnv): Promise<ExitCode> {
  if (wantsHelp(args)) {
    io.out(t("cli.backup.help"));
    return Exit.ok;
  }
  let dryRun = false;
  let json = false;
  let destinationIds: string[] | undefined;
  let only: PartKind[] | undefined;
  let aiTools: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string | null => {
      const v = args[i + 1];
      if (v === undefined) {
        io.err(t("cli.missing_value", a));
        return null;
      }
      i += 1;
      return v;
    };
    switch (a) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--json":
        json = true;
        break;
      case "--yes":
      case "-y":
        break; // rien à confirmer
      case "--destination": {
        const v = value();
        if (v === null) return Exit.usage;
        destinationIds = [...(destinationIds ?? []), v];
        break;
      }
      case "--only": {
        const v = value();
        if (v === null) return Exit.usage;
        const kind = Object.hasOwn(ONLY, v) ? ONLY[v] : undefined;
        if (!kind) {
          io.err(t("cli.unknown_option", v));
          return Exit.usage;
        }
        if (!only?.includes(kind)) only = [...(only ?? []), kind];
        break;
      }
      case "--tool": {
        const v = value();
        if (v === null) return Exit.usage;
        if (!BUNDLED_PROFILES.some((p) => p.id === v)) {
          io.err(t("cli.backup.unknown_tool", v, BUNDLED_PROFILES.map((p) => p.id).join(", ")));
          return Exit.usage;
        }
        aiTools = [...(aiTools ?? []), v];
        break;
      }
      default:
        io.err(t("cli.unknown_option", a));
        return Exit.usage;
    }
  }
  if (!(await store.exists())) {
    io.err(t("cli.config.missing", store.file));
    return Exit.usage;
  }
  let loaded: Awaited<ReturnType<typeof store.load>>;
  try {
    loaded = await store.load();
  } catch (error) {
    io.err(errorText(error));
    return Exit.usage;
  }
  if (loaded.hasErrors) {
    for (const i of loaded.issues) io.err(i.description);
    return Exit.usage;
  }
  const config = loaded.config;
  if (config.destinations.length === 0) {
    io.err(t("cli.backup.no_destination"));
    return Exit.usage;
  }
  const unknown = destinationIds?.find((id) => !config.destinations.some((d) => d.id === id));
  if (unknown !== undefined) {
    io.err(t("cli.backup.unknown_destination", unknown));
    return Exit.usage;
  }
  // `--tool` : seulement ces outils IA (la configuration de cette exécution ne garde qu'eux).
  const runConfig = aiTools ? { ...config, ai: config.ai.filter((a) => aiTools.includes(a.id)) } : config;
  // Sondé avant de commencer : sans l'Accès complet au disque, les dossiers protégés seraient sautés.
  const access: FullDiskAccess = await (
    context.fullDiskAccess ?? (() => fullDiskAccess(context.backup?.home ?? os.homedir()))
  )();
  if (access === "denied" && !json) io.err(t("cli.backup.full_disk_denied"));
  const service = new BackupService(store.paths, runConfig, defaultBackupDependencies(context.backup));
  const progress = progressPrinter(io);
  service.on((e) => {
    if (e.type === "progress") progress(e.progress);
  });
  const request: BackupRequest = { dryRun, destinationIds, only, aiTools };
  let results: BackupResult[];
  try {
    results = await service.run(request);
  } catch (error) {
    if (error instanceof OperationLockError && error.reason === "alreadyHeld") {
      io.err(t("cli.busy"));
      return Exit.failure;
    }
    io.err(errorText(error));
    return Exit.failure;
  }
  if (json) printJSON({ full_disk_access: access, results: results.map(resultJSON) }, io);
  else printResults(results, io);
  return results.every((r) => r.outcome !== null) ? Exit.ok : Exit.failure;
}
