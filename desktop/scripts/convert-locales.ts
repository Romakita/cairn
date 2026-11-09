// Conversion unique des catalogues Swift (`Localizable.strings` + `Localizable.stringsdict`) en `locales/{en,fr}.json`.
// Les JSON sont désormais la source ; ce script reste pour mémoire (`bun scripts/convert-locales.ts`, macOS : plutil).
//
// Format produit :
// - texte simple : "clé": "texte" ;
// - pluriel à une variable (`%#@n@`) : "clé": { "one": "…", "other": "…" }, choisi sur l'argument 1 ;
// - pluriel composé : "clé": { "format": "{1}, … {3}", "plurals": { "1": { "one", "other" }, "3": { … } } } ;
//   le jeton `{N}` d'une variable de pluriel est remplacé par la forme choisie sur l'argument N.
// Spécificateurs printf (`%@`, `%lld`, `%d`, `%1$@`, `%2$lld`…) → jetons positionnels `{1}`, `{2}`… ; `%%` → `%`.
// Le texte de repli du `.strings` d'une clé au pluriel n'est pas gardé : le `.stringsdict` primait toujours.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const resources = path.resolve(root, "../Cairn/Sources/CairnCore/Resources");
const categories = ["zero", "one", "two", "few", "many", "other"] as const;

type Forms = Partial<Record<(typeof categories)[number], string>>;
type Entry = string | Forms | { format: string; plurals: Record<string, Forms> };

function plist(file: string): Record<string, unknown> {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

/** Clés dans l'ordre du fichier `.strings` (plutil ne le garde pas). */
function keyOrder(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/^"((?:[^"\\]|\\.)*)"\s*=/gm)].map((m) => m[1]!);
}

const spec = /%(?:(\d+)\$)?(?:#@(\w+)@|lld|ld|d|@|%)/g;

/**
 * Remplace les spécificateurs par des jetons `{N}`. `next` numérote les spécificateurs non positionnels ;
 * `fixed` force l'indice (forme d'un pluriel non positionnel : son `%lld` désigne l'argument de la variable).
 * `vars` reçoit l'indice de chaque variable de pluriel `%#@var@`.
 */
function tokens(text: string, next: { n: number }, fixed?: number, vars?: Map<string, number>): string {
  const rest = text.replace(spec, "");
  // Un `%` isolé (« 20 %. ») reste du texte : ces clés sont lues sans arguments, donc jamais formatées.
  if (/%[\w$#@]/.test(rest)) throw new Error(`spécificateur non pris en charge : ${JSON.stringify(text)}`);
  return text.replace(spec, (match, pos: string | undefined, variable: string | undefined) => {
    if (match === "%%") return "%";
    const index = pos ? Number(pos) : (fixed ?? ++next.n);
    if (variable) vars?.set(variable, index);
    return `{${index}}`;
  });
}

function forms(rule: Record<string, unknown>, index: number): Forms {
  if (rule.NSStringFormatSpecTypeKey !== "NSStringPluralRuleType") throw new Error("règle inconnue");
  const out: Forms = {};
  for (const c of categories) {
    if (typeof rule[c] === "string") out[c] = tokens(rule[c] as string, { n: 0 }, index);
  }
  if (out.other === undefined) throw new Error("forme « other » absente");
  return out;
}

function plural(dict: Record<string, unknown>): Entry {
  const vars = new Map<string, number>();
  const format = tokens(dict.NSStringLocalizedFormatKey as string, { n: 0 }, undefined, vars);
  const plurals: Record<string, Forms> = {};
  for (const [name, index] of vars) plurals[String(index)] = forms(dict[name] as Record<string, unknown>, index);
  const only = Object.keys(plurals);
  if (format === "{1}" && only.length === 1 && only[0] === "1") return plurals["1"]!;
  return { format, plurals };
}

const order = keyOrder(path.join(resources, "en.lproj/Localizable.strings"));
const summary: string[] = [];
for (const lang of ["en", "fr"]) {
  const dir = path.join(resources, `${lang}.lproj`);
  const strings = plist(path.join(dir, "Localizable.strings")) as Record<string, string>;
  const dicts = plist(path.join(dir, "Localizable.stringsdict")) as Record<string, Record<string, unknown>>;
  const keys = Object.keys(strings);
  const missing = keys.filter((k) => !order.includes(k));
  if (missing.length > 0 || keys.length !== order.length) throw new Error(`${lang} : clés différentes de en`);
  const out: Record<string, Entry> = {};
  for (const key of order) {
    const dict = dicts[key];
    out[key] = dict ? plural(dict) : tokens(strings[key]!, { n: 0 });
  }
  for (const key of Object.keys(dicts)) if (!(key in out)) throw new Error(`${lang} : pluriel sans texte ${key}`);
  writeFileSync(path.join(root, `locales/${lang}.json`), `${JSON.stringify(out, null, 2)}\n`);
  summary.push(`${lang} : ${order.length} clés dont ${Object.keys(dicts).length} pluriels`);
}
console.log(summary.join("\n"));
