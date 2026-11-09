// Textes de l'interface (tâche 12.11, spec interface-design « Vocabulaire de l'utilisateur ») :
// (a) aucun texte visible écrit en dur dans le JSX de `src/renderer` ;
// (b) chaque clé passée en littéral à `t("…")` (interface et main) existe en anglais et en français ;
// (c) aucun mot de jargon interdit dans les catalogues des écrans (`locales/areas/*.json`).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { areaFiles, missingKeys } from "../../src/core/l10n.ts";

const ROOT = path.join(import.meta.dir, "../..");
const RENDERER = path.join(ROOT, "src/renderer");
const MAIN = path.join(ROOT, "src/main");

/** Noms propres affichés tels quels (non traduits). */
const PROPER_NAMES = new Set(["Cairn"]);
/** Mots que la spec interdit dans les textes visibles. */
const JARGON = ["rsync", "worker", "sparsebundle", "hdiutil", "fetch"];

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => ext.test(f))
    .map((f) => path.join(dir, f));
}

const relative = (file: string) => path.relative(ROOT, file);

// MARK: (a) Analyseur JSX minimal

export interface JSXText {
  line: number;
  text: string;
}

/**
 * Textes JSX littéraux d'un fichier `.tsx` (entre balises, hors `{…}` et hors attributs). Analyseur volontairement
 * simple : il saute commentaires, chaînes, gabarits et expressions régulières ; un `<` ouvre du JSX quand il suit un
 * début d'expression (`(`, `,`, `=`, `?`, `:`, `[`, `{`, `&&`, `||`, `!`, `return`, `=>`), jamais après un nom (types
 * génériques, comparaisons).
 */
export function jsxTexts(source: string): JSXText[] {
  const out: JSXText[] = [];
  let i = 0;
  const n = source.length;
  const lineAt = (pos: number) => source.slice(0, pos).split("\n").length;

  const isIdent = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

  /** Dernier mot ou caractère significatif avant `pos`. */
  const previousToken = (pos: number): string => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(source[j]!)) j -= 1;
    if (j < 0) return "";
    if (isIdent(source[j])) {
      let k = j;
      while (k > 0 && isIdent(source[k - 1])) k -= 1;
      return source.slice(k, j + 1);
    }
    return source.slice(Math.max(0, j - 1), j + 1);
  };

  const skipString = (quote: string) => {
    i += 1;
    while (i < n && source[i] !== quote) {
      if (source[i] === "\\") i += 1;
      i += 1;
    }
    i += 1;
  };

  const skipTemplate = () => {
    i += 1;
    while (i < n && source[i] !== "`") {
      if (source[i] === "\\") i += 2;
      else if (source[i] === "$" && source[i + 1] === "{") {
        i += 2;
        js("}");
        i += 1;
      } else i += 1;
    }
    i += 1;
  };

  const skipRegex = () => {
    i += 1;
    let inClass = false;
    while (i < n && (inClass || source[i] !== "/") && source[i] !== "\n") {
      if (source[i] === "\\") i += 1;
      else if (source[i] === "[") inClass = true;
      else if (source[i] === "]") inClass = false;
      i += 1;
    }
    i += 1;
    while (isIdent(source[i])) i += 1;
  };

  const skipComment = (): boolean => {
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      return true;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      return true;
    }
    return false;
  };

  const startsJSX = (pos: number): boolean => {
    if (source[pos] !== "<" || !/[A-Za-z>]/.test(source[pos + 1] ?? "")) return false;
    const prev = previousToken(pos);
    if (prev === "" || prev === "return") return true;
    if (prev.endsWith("=>") || prev.endsWith("&&") || prev.endsWith("||")) return true;
    return "(,=?:[{!".includes(prev.at(-1) ?? "");
  };

  /** Code JS jusqu'à `close` (non consommé) au même niveau d'accolades. */
  function js(close: string): void {
    let depth = 0;
    while (i < n) {
      const c = source[i]!;
      if (skipComment()) continue;
      if (c === '"' || c === "'") skipString(c);
      else if (c === "`") skipTemplate();
      else if (c === "/" && /^$|[(,=:[!&|?{};]$/.test(previousToken(i).slice(-1))) skipRegex();
      else if (c === "<" && startsJSX(i)) element();
      else if (c === "{" || c === "(" || c === "[") {
        depth += 1;
        i += 1;
      } else if (c === "}" || c === ")" || c === "]") {
        if (depth === 0 && c === close) return;
        depth -= 1;
        i += 1;
      } else i += 1;
    }
  }

  /** Élément JSX à partir de `<` : balise, attributs, enfants, balise fermante. */
  function element(): void {
    i += 1; // <
    if (source[i] === ">") {
      i += 1;
      children();
      return;
    }
    while (i < n && /[A-Za-z0-9_.$:-]/.test(source[i]!)) i += 1;
    // Arguments de type (`<PillPicker<Tab> …>`).
    if (source[i] === "<") {
      let depth = 0;
      do {
        if (source[i] === "<") depth += 1;
        else if (source[i] === ">") depth -= 1;
        i += 1;
      } while (i < n && depth > 0);
    }
    // Attributs
    while (i < n) {
      const c = source[i]!;
      if (c === "/" && source[i + 1] === ">") {
        i += 2;
        return;
      }
      if (c === ">") {
        i += 1;
        children();
        return;
      }
      if (c === '"' || c === "'") skipString(c);
      else if (c === "{") {
        i += 1;
        js("}");
        i += 1;
      } else i += 1;
    }
  }

  /** Enfants jusqu'à la balise fermante (consommée). */
  function children(): void {
    let start = i;
    const flush = (end: number) => {
      const text = source.slice(start, end).replace(/\s+/g, " ").trim();
      if (/\p{L}/u.test(text) && !PROPER_NAMES.has(text)) out.push({ line: lineAt(start), text });
    };
    while (i < n) {
      const c = source[i]!;
      if (c === "{") {
        flush(i);
        i += 1;
        js("}");
        i += 1;
        start = i;
      } else if (c === "<" && source[i + 1] === "/") {
        flush(i);
        const end = source.indexOf(">", i);
        i = end < 0 ? n : end + 1;
        return;
      } else if (c === "<") {
        flush(i);
        element();
        start = i;
      } else i += 1;
    }
  }

  js("\0");
  return out;
}

// MARK: Tests

describe("textes de l'interface", () => {
  test("l'analyseur trouve le texte JSX et ignore attributs, expressions et types", () => {
    const found = jsxTexts(`
      const a = useState<Set<string>>(new Set());
      if (x < y && y > 2) f(/<\\/?b>/);
      export function A() {
        return (
          <div className="x" aria-label={t("k")}>
            {t("ok")} · — {" "}
            <PillPicker<Tab> label={t("x")} options={[{ value: "a", label: t("a") }]} />
            <span title="not text">Hello world</span>
            <Icon />
            {cond ? <b>{v}</b> : <i>Oups</i>}
            <>Cairn</>
          </div>
        );
      }
    `);
    expect(found.map((f) => f.text)).toEqual(["Hello world", "Oups"]);
  });

  test("aucun texte visible en dur dans les écrans et composants (.tsx)", () => {
    const offenders: string[] = [];
    for (const file of files(RENDERER, /\.tsx$/)) {
      for (const { line, text } of jsxTexts(readFileSync(file, "utf8")))
        offenders.push(`${relative(file)}:${line}: ${text}`);
    }
    expect(offenders).toEqual([]);
  });

  test("chaque clé littérale de t(…) existe en anglais et en français", () => {
    const keys = new Map<string, string>();
    for (const file of [...files(RENDERER, /\.tsx?$/), ...files(MAIN, /\.ts$/)]) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?<![\w.$])t\(\s*(["'])([^"'\n]+)\1/g)) {
        if (!keys.has(m[2]!)) keys.set(m[2]!, `${relative(file)}:${source.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(keys.size).toBeGreaterThan(100);
    expect(missingKeys([...keys.keys()]).map((k) => `${k} (${keys.get(k)})`)).toEqual([]);
  });

  test("aucun mot de jargon dans les textes des écrans", () => {
    const words = new RegExp(`\\b(${JARGON.join("|")})\\b`, "i");
    const leaves = (v: unknown): string[] =>
      typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [];
    const offenders: string[] = [];
    for (const [area, file] of Object.entries(areaFiles)) {
      for (const [language, catalog] of Object.entries(file)) {
        for (const [key, value] of Object.entries(catalog as Record<string, unknown>)) {
          for (const text of leaves(value)) if (words.test(text)) offenders.push(`${area}/${language} ${key}: ${text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
