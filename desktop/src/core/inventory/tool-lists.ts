// Lecture des listes d'outils d'une sauvegarde (port de `ToolPlan.read`) : `tools.toml` (Cairn), sinon les listes
// héritées de scripts/backup.sh (`Brewfile`, `npm-globals.txt`, `uv-tools.txt`, `mise-config.toml`, `pipx.json`).
// Les commandes d'installation (`installCommand`) relèvent de la restauration.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { asArray, asInlineTable, asString, TOMLDocument, type TOMLTable } from "../toml.ts";
import { BUNDLED_RULES, commandsFor, type InventoryRules } from "./rules.ts";
import type { ToolSource } from "./types.ts";

export interface ToolToInstall {
  source: ToolSource;
  name: string;
  details: Record<string, string>;
  commands: string[];
}

/** Ordre de réinstallation : Homebrew, mise, npm, uv, pipx, cargo, go, local-bin. */
export const INSTALL_ORDER: readonly ToolSource[] = ["brew", "mise", "npm", "uv", "pipx", "cargo", "go", "local-bin"];

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function parseTree(text: string): TOMLTable | null {
  try {
    return TOMLDocument.parse(text).tree();
  } catch {
    return null;
  }
}

const lines = (text: string) => text.split("\n").filter((l) => l !== "");

export interface ToolLists {
  tools: ToolToInstall[];
  taps: string[];
  /** `Brewfile` présent (pour `brew bundle`), sinon null. */
  brewfile: string | null;
}

/** Lit les listes d'outils du dossier `dir` (`manifest/` d'une sauvegarde héritée, `tools/` d'une version Cairn). */
export async function readToolLists(dir: string, rules: InventoryRules = BUNDLED_RULES): Promise<ToolLists> {
  const tools: ToolToInstall[] = [];
  let taps: string[] = [];
  const bf = path.join(dir, "Brewfile");
  const brewfile = await stat(bf).then(
    () => bf,
    () => null,
  );

  const toml = await readText(path.join(dir, "tools.toml"));
  const tree = toml === null ? null : parseTree(toml);
  if (tree) {
    taps = (asArray(tree.value("taps")) ?? []).map(asString).filter((s): s is string => s !== undefined);
    for (const src of INSTALL_ORDER) {
      for (const e of tree.tables(src)) {
        const name = asString(e.value("name"));
        if (name === undefined) continue;
        const details: Record<string, string> = {};
        for (const k of e.keys) {
          if (k === "name" || k === "commands") continue;
          const v = asString(e.value(k));
          if (v !== undefined) details[k] = v;
        }
        const commands = asArray(e.value("commands"))
          ?.map(asString)
          .filter((s): s is string => s !== undefined);
        tools.push({ source: src, name, details, commands: commands ?? [name] });
      }
    }
    return { tools, taps, brewfile };
  }

  // Sauvegarde héritée.
  const brewText = brewfile === null ? null : await readText(brewfile);
  if (brewText !== null) {
    for (const line of lines(brewText)) {
      const parts = line.split('"').filter((p) => p !== "");
      if (parts.length < 2) continue;
      const value = parts[1] as string;
      if (line.startsWith("tap ")) taps.push(value);
      if (line.startsWith("brew "))
        tools.push({ source: "brew", name: value, details: {}, commands: commandsFor(value, rules) });
    }
  }
  const npm = await readText(path.join(dir, "npm-globals.txt"));
  if (npm !== null) {
    for (const n of lines(npm)) tools.push({ source: "npm", name: n, details: {}, commands: commandsFor(n, rules) });
  }
  const uv = await readText(path.join(dir, "uv-tools.txt"));
  if (uv !== null) {
    for (const l of lines(uv)) {
      const p = l.split("|");
      const spec = p[0];
      if (!spec) continue;
      const pieces = spec.split("[").filter((s) => s !== "");
      const name = pieces[0] ?? spec;
      const d: Record<string, string> = {};
      if (spec.includes("[")) d.extras = (pieces.at(-1) ?? "").slice(0, -1);
      if (p.length > 1 && p[1] !== "") d.python = p[1] as string;
      tools.push({ source: "uv", name, details: d, commands: [name] });
    }
  }
  // Outils de mise : section [tools] de la configuration globale sauvegardée.
  const miseText = await readText(path.join(dir, "mise-config.toml"));
  const miseTools = miseText === null ? null : parseTree(miseText)?.table("tools");
  if (miseTools) {
    for (const name of miseTools.keys) {
      const v = miseTools.value(name);
      const requested =
        asString(v) ??
        (asArray(v) ?? []).map(asString).find((s) => s !== undefined) ??
        asString(asInlineTable(v)?.find(([k]) => k === "version")?.[1]);
      const short =
        name
          .split(/[:/]/)
          .filter((s) => s !== "")
          .at(-1) ?? name;
      tools.push({
        source: "mise",
        name,
        details: requested === undefined ? {} : { requested },
        commands: commandsFor(short, rules),
      });
    }
  }
  const pipx = await readText(path.join(dir, "pipx.json"));
  if (pipx !== null) {
    try {
      const obj = JSON.parse(pipx) as unknown;
      const venvs = obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>).venvs : undefined;
      if (venvs !== null && typeof venvs === "object" && !Array.isArray(venvs)) {
        for (const n of Object.keys(venvs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
          tools.push({ source: "pipx", name: n, details: {}, commands: [n] });
        }
      }
    } catch {}
  }
  return { tools, taps, brewfile };
}
