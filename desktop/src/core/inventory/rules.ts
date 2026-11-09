// Règles d'affinage de l'inventaire (`resources/rules/rules.json`, port d'InventoryRules).
import bundledRules from "../../../resources/rules/rules.json" with { type: "json" };

export interface InventoryRules {
  /** Chemin relatif au home → commandes. */
  home: Record<string, string[]>;
  /** Fichier de projet dans un dossier suivi → commandes. */
  projects: Record<string, string[]>;
  /** Paquet → commandes. */
  aliases: Record<string, string[]>;
  historyMinUses: number;
}

function stringLists(value: unknown): Record<string, string[]> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value)) {
    // Comme `as? [String: [String]]` : une seule valeur mal formée invalide toute la table.
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return null;
    out[k] = v;
  }
  return out;
}

/** Lit un objet `rules.json` (champs absents ou mal formés : vides, `history_min_uses` = 3). */
export function parseRules(obj: unknown): InventoryRules {
  const o = obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const min = o.history_min_uses;
  return {
    home: stringLists(o.home) ?? {},
    projects: stringLists(o.projects) ?? {},
    aliases: stringLists(o.aliases) ?? {},
    historyMinUses: typeof min === "number" && Number.isInteger(min) ? min : 3,
  };
}

/** Règles fournies avec Cairn. */
export const BUNDLED_RULES: InventoryRules = parseRules(bundledRules);

/** Commandes d'un paquet : alias connus, sinon dernier segment du nom (« @scope/cli » → « scope »). */
export function commandsFor(pkg: string, rules: InventoryRules = BUNDLED_RULES): string[] {
  const alias = Object.hasOwn(rules.aliases, pkg) ? rules.aliases[pkg] : undefined;
  if (alias) return alias;
  const segments = pkg.split("/").filter((s) => s !== "");
  let base = segments.at(-1) ?? pkg;
  const at = base.indexOf("@");
  if (at > 0) base = base.slice(0, at);
  if (base === "python") return ["python3"];
  if (base === "cli" && pkg.startsWith("@") && segments[0]) return [segments[0].slice(1)];
  return [base];
}
