// Réinstallation des outils de l'inventaire (port de `ToolPlan.installCommand` et `RestoreService.reinstallTools`).
// Ordre de la spec `restore` : Command Line Tools → Homebrew (Terminal) → taps → brew, mise, npm, uv, pipx, cargo ;
// go et `~/.local/bin` sont des réinstallations manuelles (listées avec leur version). Un outil présent est ignoré ;
// chaque échec est noté et la suite continue. Le nom d'un outil vient de la sauvegarde : il n'est jamais interprété par
// le shell (`command -v -- "$1"` en argument positionnel, 46a9475).
import type { CommandRunner } from "../inventory/collector.ts";
import { INSTALL_ORDER, readToolLists, type ToolToInstall } from "../inventory/tool-lists.ts";
import { t } from "../l10n.ts";
import { COMMAND_LINE_TOOLS_INSTALL, commandLineToolsInstalled, HOMEBREW_INSTALL } from "./system.ts";

/** Commande d'installation d'un outil (`null` : réinstallation manuelle, go et `~/.local/bin`). */
export function installCommand(tool: ToolToInstall): string[] | null {
  switch (tool.source) {
    case "brew":
      return ["brew", "install", tool.name];
    case "mise":
      return ["mise", "use", "-g", `${tool.name}@${tool.details.requested ?? "latest"}`];
    case "npm":
      return ["mise", "exec", "--", "npm", "install", "-g", tool.name];
    case "uv": {
      const extras = tool.details.extras;
      const spec = extras ? `${tool.name}[${extras}]` : tool.name;
      const python = tool.details.python;
      return ["uv", "tool", "install", "--force", ...(python === undefined ? [] : ["--python", python]), spec];
    }
    case "pipx":
      return ["pipx", "install", tool.name];
    case "cargo":
      return ["cargo", "install", tool.name];
    case "go":
    case "local-bin":
      return null;
  }
}

/** Ligne de commande qui teste la présence d'une commande sans l'interpréter (nom en argument positionnel). */
export function commandProbe(command: string): string[] {
  return ["/bin/sh", "-c", 'command -v -- "$1"', "sh", command];
}

export async function commandAvailable(runner: CommandRunner, command: string): Promise<boolean> {
  return (await runner(commandProbe(command))).status === 0;
}

async function toolPresent(runner: CommandRunner, tool: ToolToInstall): Promise<boolean> {
  for (const c of tool.commands) if (await commandAvailable(runner, c)) return true;
  return false;
}

/** Outil à réinstaller à la main : source, nom et version (si l'inventaire la donne). */
export interface ManualTool {
  source: ToolToInstall["source"];
  name: string;
  version: string | null;
}

/** Résultat d'une étape (`tool:<nom>`, `command-line-tools`, `brew-install`…). */
export interface ToolStep {
  step: string;
  ok: boolean;
  detail: string;
  manual?: ManualTool;
}

export interface ReinstallOptions {
  runner: CommandRunner;
  apply: boolean;
  /** Étape administrateur ouverte dans Terminal, puis attendue ; vrai si elle a abouti. */
  waitForAdmin: (command: string) => Promise<boolean>;
  record: (step: ToolStep) => void;
  /** Arrêt demandé : les outils suivants ne sont pas lancés. */
  signal?: AbortSignal;
}

function manualDetail(version: string | null): string {
  return version ? `${t("restore.detail.manual")} (${version})` : t("restore.detail.manual");
}

/** Réinstalle les outils de `dir` dans l'ordre de la spec (simulation : rien n'est lancé, chaque étape est annoncée). */
export async function reinstallTools(dir: string, o: ReinstallOptions): Promise<void> {
  const { tools, taps } = await readToolLists(dir);
  const { runner, apply, record } = o;
  // Command Line Tools d'abord : Homebrew et les compilations en dépendent.
  if (await commandLineToolsInstalled(runner)) {
    record({ step: "command-line-tools", ok: true, detail: t("restore.detail.present") });
  } else {
    const ok = apply ? await o.waitForAdmin(COMMAND_LINE_TOOLS_INSTALL) : false;
    record({
      step: "command-line-tools",
      ok: ok || !apply,
      detail: apply ? "" : t("restore.detail.would_install", COMMAND_LINE_TOOLS_INSTALL),
    });
  }
  if (!(await commandAvailable(runner, "brew")) && tools.some((x) => x.source === "brew")) {
    const ok = apply ? await o.waitForAdmin(HOMEBREW_INSTALL) : false;
    record({ step: "brew-install", ok: ok || !apply, detail: apply ? "" : t("restore.detail.simulation") });
  }
  if (apply) for (const tap of taps) await runner(["brew", "tap", tap]);
  for (const source of INSTALL_ORDER) {
    for (const tool of tools) {
      if (tool.source !== source) continue;
      const step = `tool:${tool.name}`;
      if (await toolPresent(runner, tool)) {
        record({ step, ok: true, detail: t("restore.detail.present") });
        continue;
      }
      const cmd = installCommand(tool);
      if (cmd === null) {
        const version = tool.details.version ?? tool.details.requested ?? null;
        record({ step, ok: false, detail: manualDetail(version), manual: { source, name: tool.name, version } });
        continue;
      }
      if (!apply) {
        record({ step, ok: true, detail: t("restore.detail.would_install", cmd.join(" ")) });
        continue;
      }
      if (o.signal?.aborted) {
        record({ step, ok: false, detail: t("restore.detail.failed", -1) });
        continue;
      }
      const r = await runner(cmd);
      record({
        step,
        ok: r.status === 0,
        detail: r.status === 0 ? t("restore.detail.installed") : t("restore.detail.failed", r.status),
      });
    }
  }
}

/** Vérification finale (lecture seule) : outils de l'inventaire disponibles ou manquants (go compris). */
export async function checkTools(
  dir: string | null,
  runner: CommandRunner,
): Promise<{ present: string[]; missing: string[] }> {
  if (dir === null) return { present: [], missing: [] };
  const { tools } = await readToolLists(dir);
  const present: string[] = [];
  const missing: string[] = [];
  for (const tool of tools) ((await toolPresent(runner, tool)) ? present : missing).push(tool.name);
  return { present, missing };
}
