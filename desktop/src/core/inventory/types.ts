// Modèle de l'inventaire des outils en ligne de commande (port d'Inventory.swift). Les applications graphiques
// (casks, mas, /Applications) ne sont jamais inventoriées.
import { t } from "../l10n.ts";

/** Source d'installation, dans l'ordre de la 0.8.0 (valeurs brutes stables : JSON, `tools.toml`). */
export const TOOL_SOURCES = ["brew", "mise", "npm", "uv", "pipx", "cargo", "go", "local-bin"] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

export interface CLITool {
  name: string;
  source: ToolSource;
  version: string | null;
  /** Commandes fournies (pour l'historique et les règles). */
  commands: string[];
  /** Paramètres d'installation (extras, version de Python, version demandée, cible du lien…). */
  details: Record<string, string>;
}

export function cliTool(
  name: string,
  source: ToolSource,
  version: string | null,
  commands: string[],
  details: Record<string, string> = {},
): CLITool {
  return { name, source, version, commands, details };
}

export function toolId(tool: CLITool): string {
  return `${tool.source}:${tool.name}`;
}

/** Raison pour laquelle un outil est utilisé (ou requis). Codes stables en JSON, texte traduit à l'affichage. */
export type InventoryReason =
  /** Fichier de configuration du home (`.kube` → « ~/.kube »). */
  | { code: "home"; file: string }
  /** Fichier de projet dans un dossier suivi (`justfile`). */
  | { code: "project"; file: string }
  /** Commandes de l'outil lancées `uses` fois dans l'historique du shell. */
  | { code: "history"; uses: number };

export function reasonEquals(a: InventoryReason, b: InventoryReason): boolean {
  if (a.code === "history" || b.code === "history") {
    return a.code === b.code && (a as { uses: number }).uses === (b as { uses: number }).uses;
  }
  return a.code === b.code && a.file === b.file;
}

/** Texte affiché, dans la langue active. */
export function reasonText(r: InventoryReason): string {
  switch (r.code) {
    case "home":
      return `~/${r.file}`;
    case "project":
      return r.file;
    case "history":
      return t("inventory.reason.history", r.uses);
  }
}

export type InventoryStatus = "used" | "unused" | "missing";

export interface InventoryEntry {
  name: string;
  tool: CLITool | null;
  status: InventoryStatus;
  reasons: InventoryReason[];
  excluded: boolean;
}

export function entryId(e: InventoryEntry): string {
  return e.tool ? toolId(e.tool) : `missing:${e.name}`;
}

export interface Inventory {
  entries: InventoryEntry[];
  taps: string[];
}

export const EMPTY_INVENTORY: Inventory = Object.freeze({ entries: [], taps: [] }) as Inventory;

/** Outils retenus pour l'export (non exclus, installés). */
export function retainedTools(inv: Inventory): CLITool[] {
  return inv.entries.filter((e) => !e.excluded && e.tool).map((e) => e.tool as CLITool);
}
