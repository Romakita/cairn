// Règles du design system que Biome ne sait pas exprimer (spec interface-design).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface StyleViolation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** Seul fichier autorisé à définir des couleurs. */
const TOKENS_FILE = "src/renderer/styles/tokens.css";
/** Seul dossier autorisé à utiliser les éléments HTML natifs : la bibliothèque de composants. */
const UI_DIR = "src/renderer/ui/";

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/;
const NATIVE_ELEMENT = /<(select|input|textarea|table|button|dialog|details)\b/;
const NATIVE_TOOLTIP = /\stitle=\{|\stitle="/;

/** Contrôle un fichier ; `relative` est le chemin depuis desktop/. */
export function checkSource(relative: string, source: string): StyleViolation[] {
  const violations: StyleViolation[] = [];
  const isRenderer = relative.startsWith("src/renderer/");
  if (!isRenderer || relative === TOKENS_FILE) return violations;
  const inUi = relative.startsWith(UI_DIR);
  const isMarkup = relative.endsWith(".tsx");
  source.split("\n").forEach((text, index) => {
    const line = index + 1;
    const code = text.replace(/\/\/.*$/, "");
    if (COLOR_LITERAL.test(code)) violations.push({ file: relative, line, rule: "couleur hors jetons", text });
    if (isMarkup && !inUi && NATIVE_ELEMENT.test(code))
      violations.push({ file: relative, line, rule: "élément natif hors de ui/", text });
    if (isMarkup && NATIVE_TOOLTIP.test(code))
      violations.push({ file: relative, line, rule: "infobulle native (title)", text });
  });
  return violations;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(tsx?|css)$/.test(entry.name)) yield full;
  }
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const violations: StyleViolation[] = [];
  for await (const file of walk(path.join(root, "src/renderer"))) {
    violations.push(...checkSource(path.relative(root, file), await readFile(file, "utf8")));
  }
  for (const v of violations) console.error(`${v.file}:${v.line} ${v.rule} : ${v.text.trim()}`);
  if (violations.length > 0) process.exit(1);
  console.log("Design system : aucune violation");
}
