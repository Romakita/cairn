// Export de l'inventaire : `tools.toml`, `Brewfile` et JSON de `cairn tools --json` (port d'`InventoryExport`).
// Formats identiques à la 0.8.0 (relus par `cairn restore` et par `brew bundle`).
import path from "node:path";
import { mkdir, rename, writeFile } from "../fs-promises.ts";
import { type JSONValue, prettyJSON } from "../json.ts";
import { TOML, TOMLDocument, type TOMLValue } from "../toml.ts";
import { type Inventory, type InventoryReason, retainedTools } from "./types.ts";

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const TOOLS_HEADER = "# Outils CLI exportés par Cairn — relus par `cairn restore` pour la réinstallation.\n\n";

/** `tools.toml` : outils retenus regroupés par source, avec leurs paramètres d'installation. */
export function toolsTOML(inv: Inventory): string {
  const doc = TOMLDocument.parse(TOOLS_HEADER);
  doc.set(TOML.integer(1), ["version"]);
  doc.set(TOML.array(inv.taps.map(TOML.string)), ["taps"]);
  const tools = retainedTools(inv).sort((a, b) => byCodePoint(a.source, b.source) || byCodePoint(a.name, b.name));
  for (const t of tools) {
    const values: Array<[string, TOMLValue]> = [["name", TOML.string(t.name)]];
    if (t.version !== null) values.push(["version", TOML.string(t.version)]);
    for (const k of Object.keys(t.details).sort(byCodePoint)) values.push([k, TOML.string(t.details[k] as string)]);
    values.push(["commands", TOML.array(t.commands.map(TOML.string))]);
    doc.appendArrayTable([t.source], values);
  }
  return doc.render();
}

/** Brewfile compatible `brew bundle` : taps et formules seulement (jamais de cask ni de mas). */
export function brewfile(inv: Inventory): string {
  const out = inv.taps.map((tap) => `tap "${tap}"`);
  for (const t of retainedTools(inv)) if (t.source === "brew") out.push(`brew "${t.name}"`);
  return `${out.join("\n")}\n`;
}

/** Forme JSON d'une raison, indépendante de la langue : `{"code":"history","uses":5}`, `{"code":"home","file":…}`. */
export function reasonJSON(r: InventoryReason): JSONValue {
  return r.code === "history" ? { code: r.code, uses: r.uses } : { code: r.code, file: r.file };
}

/** Données de `cairn tools --json` : identifiants et codes stables, identiques quelle que soit la langue. */
export function inventoryJSONValue(inv: Inventory): JSONValue {
  const tools: JSONValue[] = inv.entries.map((e) => {
    const d: Record<string, JSONValue> = {
      name: e.name,
      status: e.status,
      reasons: e.reasons.map(reasonJSON),
      excluded: e.excluded,
    };
    if (e.tool) {
      d.source = e.tool.source;
      d.version = e.tool.version;
      d.commands = e.tool.commands;
      d.details = e.tool.details;
    }
    return d;
  });
  return { tools, taps: inv.taps };
}

/** Sortie de `cairn tools --json` (2 espaces, clés triées, comme la 0.8.0). */
export function inventoryJSON(inv: Inventory): string {
  return prettyJSON(inventoryJSONValue(inv));
}

async function writeAtomically(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/** Écrit `tools.toml` et `Brewfile` dans `dir` (créé au besoin). */
export async function writeInventory(inv: Inventory, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeAtomically(path.join(dir, "tools.toml"), toolsTOML(inv));
  await writeAtomically(path.join(dir, "Brewfile"), brewfile(inv));
}
