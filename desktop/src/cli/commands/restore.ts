// `cairn restore [--from DIR | --destination ID] [--version V] [--parts a,b] [--target NOM=CHEMIN]… [--tool ID]…
// [--replace-databases] [--check] [--apply] [--yes] [--json]` (port de `CLI.restore`).
// SIMULATION par défaut : rien n'est écrit sans `--apply`, qui demande confirmation (sauf `--yes`) ; le verrou
// `restore` est pris par `RestoreService`. La destination est ouverte sans rien créer ; sur un Mac neuf, les mots de
// passe du partage et de l'image sont demandés sans écho. Les étapes administrateur (Homebrew) s'ouvrent dans
// Terminal ; un outil IA ouvert doit être quitté avant que ses données soient restaurées.

import { displayName } from "../../core/ai/profiles.ts";
import { keychainSecrets } from "../../core/backup/secrets.ts";
import { DestinationSession } from "../../core/backup/session.ts";
import { isoDate } from "../../core/dates.ts";
import { Fmt } from "../../core/format.ts";
import { systemRunner } from "../../core/inventory/collector.ts";
import type { JSONValue } from "../../core/json.ts";
import { t } from "../../core/l10n.ts";
import { OperationLockError } from "../../core/lock.ts";
import { machineName } from "../../core/machine.ts";
import { expandTilde } from "../../core/paths.ts";
import { openForRestore } from "../../core/restore/destination.ts";
import {
  defaultPlan,
  folderTargets,
  quitWaiter,
  type RestorePlan,
  RestoreService,
} from "../../core/restore/service.ts";
import {
  archMatches,
  chooseVersion,
  currentArch,
  openRestoreSource,
  type RestoreSource,
} from "../../core/restore/source.ts";
import { targetIsMissing, terminalAdminWaiter } from "../../core/restore/system.ts";
import { confirm as askConfirmation, askPassword as askHidden } from "../prompt.ts";
import { type CommandEnv, Exit, type ExitCode, errorText, pad, printJSON, readConfig, wantsHelp } from "../shared.ts";

interface Options {
  from?: string;
  destinationId?: string;
  version?: string;
  parts?: Set<string>;
  targets: Record<string, string>;
  tools: string[];
  apply: boolean;
  yes: boolean;
  check: boolean;
  replaceDatabases: boolean;
  json: boolean;
}

/** Arguments ; `null` : erreur d'usage (valeur absente, `--target` sans `=`, option inconnue). */
function parse(args: readonly string[], unknown: (option: string) => void): Options | null {
  const o: Options = {
    targets: {},
    tools: [],
    apply: false,
    yes: false,
    check: false,
    replaceDatabases: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string | undefined => {
      i += 1;
      return args[i];
    };
    switch (a) {
      case "--json":
        o.json = true;
        break;
      case "--from": {
        const v = value();
        if (v === undefined) return null;
        o.from = expandTilde(v);
        break;
      }
      case "--destination": {
        const v = value();
        if (v === undefined) return null;
        o.destinationId = v;
        break;
      }
      case "--version": {
        const v = value();
        if (v === undefined) return null;
        o.version = v;
        break;
      }
      case "--parts": {
        const v = value();
        if (v === undefined) return null;
        o.parts = new Set(v.split(",").filter((p) => p !== ""));
        break;
      }
      case "--target": {
        const v = value();
        const eq = v?.indexOf("=") ?? -1;
        if (v === undefined || eq < 0) return null;
        o.targets[v.slice(0, eq)] = expandTilde(v.slice(eq + 1));
        break;
      }
      case "--tool": {
        const v = value();
        if (v === undefined) return null;
        o.tools.push(v);
        break;
      }
      case "--replace-databases":
        o.replaceDatabases = true;
        break;
      case "--apply":
        o.apply = true;
        break;
      case "--yes":
      case "-y":
        o.yes = true;
        break;
      case "--check":
        o.check = true;
        break;
      default:
        unknown(a);
        return null;
    }
  }
  return o;
}

export async function restore({ args, store, io, context }: CommandEnv): Promise<ExitCode> {
  if (wantsHelp(args)) {
    io.out(t("cli.restore.help"));
    return Exit.ok;
  }
  const o = parse(args, (a) => io.err(t("cli.unknown_option", a)));
  if (!o) return Exit.usage;
  const ask = context.askPassword ?? askHidden;

  // Source : dossier donné, ou version d'une destination configurée.
  let session: DestinationSession | null = null;
  try {
    let sourceDir: string;
    if (o.from !== undefined) {
      sourceDir = o.from;
    } else {
      const config = await readConfig(store);
      const d = config.destinations.find((x) => o.destinationId === undefined || x.id === o.destinationId);
      if (!d) {
        io.err(t("cli.backup.no_destination"));
        return Exit.usage;
      }
      const overrides = context.backup ?? {};
      const machine = overrides.machine ?? (await machineName());
      session = new DestinationSession(d, { ...overrides, secrets: overrides.secrets ?? keychainSecrets, machine });
      let opened: Awaited<ReturnType<typeof openForRestore>>;
      try {
        // Mac neuf : le Trousseau est vide, les mots de passe sont demandés.
        opened = await openForRestore(session, (kind) =>
          ask(kind === "share" ? t("cli.restore.share_password", d.url ?? d.id) : t("cli.restore.image_password")),
        );
      } catch (error) {
        io.err(errorText(error));
        return Exit.failure;
      }
      if (!opened) return Exit.failure;
      // Version demandée absente : erreur d'usage, jamais de repli silencieux sur une autre version.
      const choice = chooseVersion(opened.versions, machine, o.version);
      if ("error" in choice) {
        if (choice.error === "unknownVersion") {
          io.err(t("cli.verify.unknown_version", o.version ?? ""));
          return Exit.usage;
        }
        io.err(t("cli.restore.no_version"));
        return Exit.failure;
      }
      sourceDir = choice.path;
    }
    const source = await openRestoreSource(sourceDir);
    if (!source) {
      io.err(t("cli.restore.unknown_format", sourceDir));
      return Exit.failure;
    }
    return await restoreFrom(source, o, { store, io, context, args });
  } finally {
    await session?.close().catch(() => {});
  }
}

async function restoreFrom(source: RestoreSource, o: Options, env: CommandEnv): Promise<ExitCode> {
  const { io, store, context } = env;
  const overrides = context.restore ?? {};
  const home = overrides.home ?? context.backup?.home;
  const service = new RestoreService(source, {
    statePaths: { stateDir: store.paths.state },
    waitForAdmin: terminalAdminWaiter({
      runner: overrides.runner ?? systemRunner(home),
      onOpen: () => io.err(t("cli.restore.terminal")),
    }),
    waitForQuit: quitWaiter({ onWait: (p) => io.err(t("restore.quit_tool", displayName(p))) }),
    ...overrides,
    ...(home !== undefined ? { home } : {}),
  });
  // En JSON, la sortie standard ne reçoit qu'un objet ; les messages restent sur la sortie d'erreur.
  const human = (text: string) => {
    if (!o.json) io.out(text);
  };
  const report: Record<string, JSONValue> = {
    source: {
      kind: source.kind,
      path: source.root,
      date: source.date ? isoDate(source.date) : null,
      machine: source.machine,
      arch: source.arch,
      arch_matches: archMatches(source),
    },
    apply: o.apply,
  };
  human(
    t(
      "cli.restore.source",
      source.kind === "legacy" ? t("cli.restore.legacy") : "Cairn",
      source.date ? Fmt.date(source.date) : "—",
      source.machine,
      source.arch,
    ),
  );
  if (!archMatches(source)) io.err(t("cli.restore.arch_warning", source.arch, currentArch()));

  if (o.check) {
    const { present, missing } = await service.check();
    if (o.json) {
      report.check = { present, missing };
      printJSON(report, io);
      return Exit.ok;
    }
    io.out(t("cli.restore.check", present.length, missing.length));
    for (const m of missing) io.out(`  ✗ ${m}`);
    io.out(t("cli.restore.manual"));
    return Exit.ok;
  }

  const want = (p: string) => o.parts?.has(p) ?? true;
  // --tool ID (répétable) : seulement ces outils IA ; un outil absent de la sauvegarde est une erreur d'usage.
  const missingTool = o.tools.find((id) => !source.aiTools.includes(id));
  if (missingTool !== undefined) {
    io.err(t("cli.restore.unknown_tool", missingTool, source.aiTools.join(", ")));
    return Exit.usage;
  }
  const plan: RestorePlan = {
    ...defaultPlan(),
    tools: want("tools"),
    home: want("home") && source.home !== null,
    ai: want("ai")
      ? o.tools.length === 0
        ? [...source.aiTools]
        : source.aiTools.filter((x) => o.tools.includes(x))
      : [],
    replaceDatabases: o.replaceDatabases,
    folders: folderTargets(),
  };
  if (want("folders"))
    for (const f of source.folders)
      plan.folders[f.name] = (Object.hasOwn(o.targets, f.name) ? o.targets[f.name] : undefined) ?? f.originalPath;
  for (const [name, target] of Object.entries(plan.folders)) {
    if (await targetIsMissing(target)) io.err(t("cli.restore.missing_target", name, target));
  }
  const sizes = await service.sizes(plan);
  report.bytes_by_part = sizes;
  report.folders = plan.folders;
  for (const part of Object.keys(sizes).sort()) human(`  ${pad(part, 28)} ${Fmt.bytes(sizes[part] ?? 0)}`);
  if (o.apply && !o.yes && !(await (context.confirm ?? askConfirmation)(t("cli.restore.confirm")))) {
    io.err(t("cli.cancelled"));
    return Exit.failure;
  }
  let steps: Awaited<ReturnType<RestoreService["run"]>>;
  try {
    steps = await service.run(plan, { apply: o.apply });
  } catch (error) {
    if (error instanceof OperationLockError && error.reason === "alreadyHeld") {
      io.err(t("cli.busy"));
      return Exit.failure;
    }
    throw error;
  }
  const ok = steps.every((s) => s.ok);
  if (o.json) {
    report.steps = steps.map((s) => ({ step: s.step, ok: s.ok, detail: s.detail }));
    report.ok = ok;
    printJSON(report, io);
    return ok ? Exit.ok : Exit.failure;
  }
  for (const s of steps) {
    const line = `  ${s.ok ? "✓ " : "✗ "}${s.step}${s.detail === "" ? "" : ` — ${s.detail}`}`;
    if (s.ok) io.out(line);
    else io.err(line);
  }
  io.out(t(o.apply ? "cli.restore.manual" : "cli.restore.simulation"));
  return ok ? Exit.ok : Exit.failure;
}
