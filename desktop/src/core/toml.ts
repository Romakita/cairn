// Lecteur/écrivain TOML « sans perte » (port de TOML.swift) limité au sous-ensemble dont Cairn a besoin :
// tables, tableaux de tables, chaînes, entiers, flottants, booléens, tableaux et tables en ligne.
// Le texte d'origine est conservé ligne à ligne : réécrire un document non modifié redonne le même texte,
// commentaires et clés inconnues compris. Une modification ne touche que la valeur concernée.
import { t } from "./l10n.ts";

// MARK: Valeurs

export type TOMLValue =
  | { type: "string"; value: string }
  | { type: "integer"; value: number }
  | { type: "double"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "array"; value: TOMLValue[] }
  | { type: "inlineTable"; value: Array<[string, TOMLValue]> };

/** Constructeurs. */
export const TOML = {
  string: (value: string): TOMLValue => ({ type: "string", value }),
  integer: (value: number): TOMLValue => ({ type: "integer", value }),
  double: (value: number): TOMLValue => ({ type: "double", value }),
  bool: (value: boolean): TOMLValue => ({ type: "bool", value }),
  array: (value: TOMLValue[]): TOMLValue => ({ type: "array", value }),
  inlineTable: (value: Array<[string, TOMLValue]>): TOMLValue => ({ type: "inlineTable", value }),
};

export function tomlEquals(a: TOMLValue, b: TOMLValue): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "array": {
      const y = b.value as TOMLValue[];
      return a.value.length === y.length && a.value.every((v, i) => tomlEquals(v, y[i] as TOMLValue));
    }
    case "inlineTable": {
      const y = b.value as Array<[string, TOMLValue]>;
      return (
        a.value.length === y.length &&
        a.value.every(([k, v], i) => {
          const other = y[i] as [string, TOMLValue];
          return k === other[0] && tomlEquals(v, other[1]);
        })
      );
    }
    default:
      return a.value === b.value;
  }
}

export function asString(v: TOMLValue | undefined): string | undefined {
  return v?.type === "string" ? v.value : undefined;
}

export function asInteger(v: TOMLValue | undefined): number | undefined {
  return v?.type === "integer" ? v.value : undefined;
}

export function asBool(v: TOMLValue | undefined): boolean | undefined {
  return v?.type === "bool" ? v.value : undefined;
}

/** Flottant, ou entier converti. */
export function asDouble(v: TOMLValue | undefined): number | undefined {
  return v?.type === "double" || v?.type === "integer" ? v.value : undefined;
}

export function asArray(v: TOMLValue | undefined): TOMLValue[] | undefined {
  return v?.type === "array" ? v.value : undefined;
}

export function asInlineTable(v: TOMLValue | undefined): Array<[string, TOMLValue]> | undefined {
  return v?.type === "inlineTable" ? v.value : undefined;
}

/** Nom du type, pour les messages d'erreur. */
export function typeName(v: TOMLValue): string {
  switch (v.type) {
    case "string":
      return "string";
    case "integer":
      return "integer";
    case "double":
      return "float";
    case "bool":
      return "boolean";
    case "array":
      return "array";
    case "inlineTable":
      return "table";
  }
}

/**
 * `String(Double)` de Swift : chiffres les plus courts, notation exponentielle sous 1e-4 et au-delà de 2^53
 * (`1e+16`, `1e-05`), `inf`, `nan`, `-0.0`.
 */
export function swiftDoubleDescription(d: number): string {
  if (Number.isNaN(d)) return "nan";
  if (d === Number.POSITIVE_INFINITY) return "inf";
  if (d === Number.NEGATIVE_INFINITY) return "-inf";
  if (d === 0) return Object.is(d, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(d);
  if (abs < 1e-4 || abs > 2 ** 53) {
    return d.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  const s = String(d);
  return s.includes(".") ? s : `${s}.0`;
}

function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      default: {
        const code = ch.codePointAt(0) as number;
        out += code < 0x20 ? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}` : ch;
      }
    }
  }
  return `${out}"`;
}

/** Clé nue si possible (`[A-Za-z0-9_-]+`), sinon entre guillemets. */
export function renderKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : quote(k);
}

/** Écriture TOML de la valeur. */
export function renderValue(v: TOMLValue): string {
  switch (v.type) {
    case "string":
      return quote(v.value);
    case "integer":
      return String(v.value);
    case "double": {
      const s = swiftDoubleDescription(v.value);
      return s.includes(".") || s.includes("e") ? s : `${s}.0`;
    }
    case "bool":
      return v.value ? "true" : "false";
    case "array":
      return `[${v.value.map(renderValue).join(", ")}]`;
    case "inlineTable":
      return v.value.length === 0
        ? "{}"
        : `{ ${v.value.map(([k, x]) => `${renderKey(k)} = ${renderValue(x)}`).join(", ")} }`;
  }
}

export class TOMLError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
    this.name = "TOMLError";
  }

  get description(): string {
    return `line ${this.line}: ${this.message}`;
  }
}

// MARK: Document

export type TOMLKind =
  | { type: "trivia" } // ligne vide ou commentaire
  | { type: "table"; path: string[] } // [a.b]
  | { type: "arrayTable"; path: string[] } // [[a.b]]
  | { type: "keyValue"; key: string[] }; // a.b = valeur (clé relative à la table courante)

export interface TOMLItem {
  kind: TOMLKind;
  /** Texte exact, saut de ligne final compris. */
  raw: string;
  /** Numéro de la première ligne (1-based). */
  line: number;
  value?: TOMLValue;
  /** Position de la valeur dans `raw` (unités UTF-16, début inclus, fin exclue). */
  valueRange?: [number, number];
}

/** Contexte (table courante) d'un élément : chemin de table et, pour un tableau de tables, l'index. */
interface Section {
  path: string[];
  arrayIndex: number | null;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameSection(a: Section, b: Section): boolean {
  return a.arrayIndex === b.arrayIndex && samePath(a.path, b.path);
}

function isTrivia(item: TOMLItem): boolean {
  return item.kind.type === "trivia";
}

function isHeader(item: TOMLItem): boolean {
  return item.kind.type === "table" || item.kind.type === "arrayTable";
}

function endsWithNewline(raw: string): boolean {
  // En scalaires : « \r\n » se termine bien par "\n".
  return raw.endsWith("\n");
}

/** Espaces de `CharacterSet.whitespaces` (sans les sauts de ligne). */
function trimInlineWhitespace(s: string): string {
  return s.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, "");
}

export class TOMLDocument {
  private constructor(private itemList: TOMLItem[]) {}

  /** Analyse un texte ; lève `TOMLError` (avec la ligne) sur une erreur de syntaxe ou une clé en double. */
  static parse(text: string): TOMLDocument {
    const doc = new TOMLDocument(new Parser(text).parseAll());
    doc.tree(); // détecte les clés en double
    return doc;
  }

  get items(): readonly TOMLItem[] {
    return this.itemList;
  }

  /** Copie indépendante (le document Swift est une valeur). */
  clone(): TOMLDocument {
    return new TOMLDocument(this.itemList.map((i) => ({ ...i })));
  }

  /** Texte du document. */
  render(): string {
    return this.itemList.map((i) => i.raw).join("");
  }

  private sections(): Section[] {
    const result: Section[] = [];
    let current: Section = { path: [], arrayIndex: null };
    const counts = new Map<string, number>();
    for (const item of this.itemList) {
      if (item.kind.type === "table") {
        current = { path: item.kind.path, arrayIndex: null };
      } else if (item.kind.type === "arrayTable") {
        const id = JSON.stringify(item.kind.path);
        const i = counts.get(id) ?? 0;
        counts.set(id, i + 1);
        current = { path: item.kind.path, arrayIndex: i };
      }
      result.push(current);
    }
    return result;
  }

  /** Arbre des valeurs : table racine. */
  tree(): TOMLTable {
    const root = new TOMLTable();
    const secs = this.sections();
    this.itemList.forEach((item, i) => {
      const kind = item.kind;
      switch (kind.type) {
        case "table":
          root.ensureTable(kind.path, item.line);
          break;
        case "arrayTable":
          root.appendArrayTable(kind.path, item.line);
          break;
        case "keyValue":
          if (item.value) root.insert(item.value, (secs[i] as Section).path, kind.key, item.line);
          break;
        case "trivia":
          break;
      }
    });
    return root;
  }

  /** Ligne d'une clé (pour les messages d'erreur), si elle existe. */
  line(section: string[], key: string[], arrayIndex: number | null = null): number | null {
    const secs = this.sections();
    const target: Section = { path: section, arrayIndex };
    for (const [i, item] of this.itemList.entries()) {
      if (item.kind.type === "keyValue" && samePath(item.kind.key, key) && sameSection(secs[i] as Section, target)) {
        return item.line;
      }
    }
    return null;
  }

  // MARK: Écriture

  /** Remplace ou ajoute `key = value` dans une table (`section` vide = racine). Les commentaires restent en place. */
  set(value: TOMLValue, key: string[], section: string[] = [], arrayIndex: number | null = null): void {
    const target: Section = { path: section, arrayIndex };
    const secs = this.sections();
    const items = this.itemList;
    // 1. Clé existante : on ne remplace que la valeur.
    for (const [i, item] of items.entries()) {
      if (
        item.kind.type === "keyValue" &&
        samePath(item.kind.key, key) &&
        sameSection(secs[i] as Section, target) &&
        item.valueRange
      ) {
        const [lo, hi] = item.valueRange;
        const raw = item.raw.slice(0, lo) + renderValue(value) + item.raw.slice(hi);
        items[i] = TOMLDocument.reparse(raw, item.line) ?? item;
        this.renumber();
        return;
      }
    }
    // 2. Nouvelle clé : après la dernière paire clé/valeur de la table, sinon juste après son en-tête.
    const newLine = `${key.map(renderKey).join(".")} = ${renderValue(value)}\n`;
    const newItem = TOMLDocument.reparse(newLine, 0) as TOMLItem;
    let insertAt: number | null = null;
    let headerIndex: number | null = null;
    for (const [i, item] of items.entries()) {
      if (!sameSection(secs[i] as Section, target)) continue;
      if (isHeader(item)) headerIndex = i;
      else if (item.kind.type === "keyValue") insertAt = i + 1;
    }
    if (target.path.length === 0 && headerIndex === null && insertAt === null) {
      // Racine vide : avant le premier en-tête.
      const firstHeader = items.findIndex(isHeader);
      if (firstHeader < 0) insertAt = items.length;
      else insertAt = firstHeader > 0 && isTrivia(items[firstHeader - 1] as TOMLItem) ? firstHeader - 1 : firstHeader;
    }
    const at: number | null = insertAt ?? (headerIndex !== null ? headerIndex + 1 : null);
    if (at !== null) {
      this.newlineBefore(at);
      items.splice(at, 0, newItem);
    } else {
      // La table n'existe pas : on l'ajoute à la fin.
      this.ensureTrailingNewline();
      if (items.length > 0) items.push(TOMLDocument.reparse("\n", 0) as TOMLItem);
      const header = `[${section.map(renderKey).join(".")}]\n`;
      items.push(TOMLDocument.reparse(header, 0) as TOMLItem);
      items.push(newItem);
    }
    this.renumber();
  }

  /** Supprime une clé si elle existe. */
  remove(key: string[], section: string[] = [], arrayIndex: number | null = null): void {
    const target: Section = { path: section, arrayIndex };
    const secs = this.sections();
    const i = this.itemList.findIndex(
      (item, idx) =>
        item.kind.type === "keyValue" && samePath(item.kind.key, key) && sameSection(secs[idx] as Section, target),
    );
    if (i >= 0) {
      this.itemList.splice(i, 1);
      this.renumber();
    }
  }

  /** Nombre d'éléments d'un tableau de tables. */
  arrayTableCount(path: string[]): number {
    return this.itemList.filter((i) => i.kind.type === "arrayTable" && samePath(i.kind.path, path)).length;
  }

  /** Ajoute un élément `[[path]]` après le dernier existant (ou à la fin) et renvoie son index. */
  appendArrayTable(path: string[], values: Array<[string, TOMLValue]>): number {
    const index = this.arrayTableCount(path);
    let block = `[[${path.map(renderKey).join(".")}]]\n`;
    for (const [k, v] of values) block += `${renderKey(k)} = ${renderValue(v)}\n`;
    let newItems: TOMLItem[];
    try {
      newItems = new Parser(block).parseAll();
    } catch {
      newItems = [];
    }
    const secs = this.sections();
    const items = this.itemList;
    let last = -1;
    secs.forEach((s, i) => {
      if (samePath(s.path, path) && s.arrayIndex !== null) last = i;
    });
    if (last >= 0) {
      // Fin du dernier bloc : après sa dernière ligne non vide.
      let at = last + 1;
      while (at - 1 > 0 && isTrivia(items[at - 1] as TOMLItem) && samePath((secs[at - 1] as Section).path, path)) {
        at -= 1;
      }
      this.newlineBefore(at);
      items.splice(at, 0, TOMLDocument.reparse("\n", 0) as TOMLItem, ...newItems);
    } else {
      this.ensureTrailingNewline();
      if (items.length > 0) items.push(TOMLDocument.reparse("\n", 0) as TOMLItem);
      items.push(...newItems);
    }
    this.renumber();
    return index;
  }

  /** Supprime l'élément `index` d'un tableau de tables (en-tête et ses lignes, jusqu'à l'en-tête suivant). */
  removeArrayTable(path: string[], index: number): void {
    const secs = this.sections();
    const target: Section = { path, arrayIndex: index };
    const items = this.itemList;
    const idx = items.map((_, i) => i).filter((i) => sameSection(secs[i] as Section, target));
    if (idx.length === 0) return;
    const first = idx[0] as number;
    let last = idx[idx.length - 1] as number;
    // Garder les commentaires/vides qui précèdent l'en-tête suivant.
    while (last > first && isTrivia(items[last] as TOMLItem)) last -= 1;
    items.splice(first, last - first + 1);
    if (
      first > 0 &&
      first < items.length &&
      isTrivia(items[first - 1] as TOMLItem) &&
      isTrivia(items[first] as TOMLItem) &&
      trimInlineWhitespace((items[first] as TOMLItem).raw) === "\n"
    ) {
      items.splice(first, 1);
    }
    this.renumber();
  }

  /**
   * Supprime une table et tout ce qu'elle contient : en-têtes `[path]` et `[path.x]` avec leurs lignes,
   * et clés pointées (`x.y = …` sous une table parente). Les commentaires qui précèdent l'en-tête suivant restent.
   */
  removeTable(path: string[]): void {
    const under = (p: readonly string[]) => p.length >= path.length && samePath(p.slice(0, path.length), path);
    const secs = this.sections();
    const items = this.itemList;
    const drop = new Array<boolean>(items.length).fill(false);
    let i = 0;
    while (i < items.length) {
      const item = items[i] as TOMLItem;
      const kind = item.kind;
      if ((kind.type === "table" || kind.type === "arrayTable") && under(kind.path)) {
        // Bloc de l'en-tête : jusqu'à l'en-tête suivant, sans les lignes vides et commentaires de fin.
        let end = i + 1;
        while (end < items.length && sameSection(secs[end] as Section, secs[i] as Section)) end += 1;
        let last = end - 1;
        while (last > i && isTrivia(items[last] as TOMLItem)) last -= 1;
        for (let j = i; j <= last; j++) drop[j] = true;
        i = end;
        continue;
      }
      const sec = secs[i] as Section;
      if (kind.type === "keyValue" && sec.arrayIndex === null && under([...sec.path, ...kind.key])) drop[i] = true;
      i += 1;
    }
    // Plages contiguës, de la dernière à la première.
    const ranges: Array<[number, number]> = [];
    for (let j = 0; j < drop.length; j++) {
      if (!drop[j]) continue;
      const start = j;
      while (j + 1 < drop.length && drop[j + 1]) j++;
      ranges.push([start, j + 1]);
    }
    if (ranges.length === 0) return;
    for (const [lo, hi] of ranges.reverse()) {
      items.splice(lo, hi - lo);
      // Pas deux lignes vides de suite à la jonction.
      const at = lo;
      if (
        at > 0 &&
        at < items.length &&
        (items[at - 1] as TOMLItem).raw.trim() === "" &&
        (items[at] as TOMLItem).raw.trim() === ""
      ) {
        items.splice(at, 1);
      }
    }
    this.renumber();
  }

  private ensureTrailingNewline(): void {
    const last = this.itemList[this.itemList.length - 1];
    if (last && !endsWithNewline(last.raw)) last.raw += "\n";
  }

  /**
   * L'élément qui précède une insertion doit finir par un saut de ligne (dernière ligne d'un fichier sans saut de
   * ligne final) ; sinon la nouvelle ligne serait collée à la précédente.
   */
  private newlineBefore(at: number): void {
    const prev = this.itemList[at - 1];
    if (at > 0 && prev && !endsWithNewline(prev.raw)) prev.raw += "\n";
  }

  private renumber(): void {
    let line = 1;
    for (const item of this.itemList) {
      item.line = line;
      for (const ch of item.raw) if (ch === "\n") line += 1;
    }
  }

  private static reparse(raw: string, line: number): TOMLItem | null {
    let items: TOMLItem[];
    try {
      items = new Parser(raw).parseAll();
    } catch {
      return null;
    }
    const item = items[0];
    if (!item) return null;
    item.line = line;
    return item;
  }
}

// MARK: Arbre de lecture

export type TOMLEntry =
  | { type: "value"; value: TOMLValue; line: number }
  | { type: "table"; table: TOMLTable }
  | { type: "arrayOfTables"; tables: TOMLTable[] };

export class TOMLTable {
  /** Clés dans l'ordre du fichier. */
  readonly keys: string[] = [];
  readonly entries = new Map<string, TOMLEntry>();
  /** Ligne de l'en-tête (0 pour une table implicite). */
  line = 0;

  get(key: string): TOMLEntry | undefined {
    return this.entries.get(key);
  }

  value(key: string): TOMLValue | undefined {
    const e = this.entries.get(key);
    return e?.type === "value" ? e.value : undefined;
  }

  valueLine(key: string): number | null {
    const e = this.entries.get(key);
    return e?.type === "value" ? e.line : null;
  }

  table(key: string): TOMLTable | undefined {
    const e = this.entries.get(key);
    return e?.type === "table" ? e.table : undefined;
  }

  tables(key: string): TOMLTable[] {
    const e = this.entries.get(key);
    return e?.type === "arrayOfTables" ? e.tables : [];
  }

  private set(key: string, e: TOMLEntry): void {
    if (!this.entries.has(key)) this.keys.push(key);
    this.entries.set(key, e);
  }

  /** @internal */
  ensureTable(path: string[], line: number): void {
    const [head, ...rest] = path;
    if (head === undefined) return;
    const e = this.entries.get(head);
    if (e === undefined) {
      const t = new TOMLTable();
      t.line = line;
      t.ensureTable(rest, line);
      this.set(head, { type: "table", table: t });
    } else if (e.type === "table") {
      e.table.ensureTable(rest, line);
    } else if (e.type === "arrayOfTables") {
      const last = e.tables[e.tables.length - 1];
      if (rest.length === 0 || !last) throw new TOMLError(line, t("toml.table_defined", head));
      last.ensureTable(rest, line);
    } else {
      throw new TOMLError(line, t("toml.already_value", head));
    }
  }

  /** @internal */
  appendArrayTable(path: string[], line: number): void {
    const [head, ...rest] = path;
    if (head === undefined) return;
    const e = this.entries.get(head);
    if (rest.length === 0) {
      const t0 = new TOMLTable();
      t0.line = line;
      if (e === undefined) this.set(head, { type: "arrayOfTables", tables: [t0] });
      else if (e.type === "arrayOfTables") e.tables.push(t0);
      else throw new TOMLError(line, t("toml.not_array_table", head));
      return;
    }
    if (e === undefined) {
      const t0 = new TOMLTable();
      t0.appendArrayTable(rest, line);
      this.set(head, { type: "table", table: t0 });
    } else if (e.type === "table") {
      e.table.appendArrayTable(rest, line);
    } else if (e.type === "arrayOfTables") {
      const last = e.tables[e.tables.length - 1];
      if (!last) return;
      last.appendArrayTable(rest, line);
    } else {
      throw new TOMLError(line, t("toml.already_value", head));
    }
  }

  /** @internal Insère une valeur dans la section donnée (dernier élément pour un tableau de tables). */
  insert(value: TOMLValue, path: string[], key: string[], line: number): void {
    const [head, ...rest] = path;
    if (head !== undefined) {
      const e = this.entries.get(head);
      if (e?.type === "table") {
        e.table.insert(value, rest, key, line);
      } else if (e?.type === "arrayOfTables") {
        const last = e.tables[e.tables.length - 1];
        if (!last) return;
        last.insert(value, rest, key, line);
      } else {
        const t0 = new TOMLTable();
        t0.insert(value, rest, key, line);
        this.set(head, { type: "table", table: t0 });
      }
      return;
    }
    const [k, ...more] = key;
    if (k === undefined) return;
    if (more.length === 0) {
      if (this.entries.has(k)) throw new TOMLError(line, t("toml.duplicate_key", k));
      this.set(k, { type: "value", value, line });
    } else {
      if (this.entries.has(k) && !this.table(k)) throw new TOMLError(line, t("toml.already_value", k));
      const t0 = this.table(k) ?? new TOMLTable();
      t0.insert(value, [], more, line);
      this.set(k, { type: "table", table: t0 });
    }
  }
}

// MARK: Analyseur

const isAsciiKeyChar = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9_-]$/.test(c);
const isNumberChar = (c: string) => /^[\p{N}+\-_.eE:TZ]$/u.test(c);

class Parser {
  /**
   * Un élément par scalaire Unicode : « \r\n » reste deux éléments (en `Character` Swift, ce serait un seul
   * graphème, égal ni à "\r" ni à "\n" : fichier CRLF illisible, ou commentaire qui avalerait la suite du fichier).
   */
  private readonly chars: string[];
  private pos = 0;
  private line = 1;

  constructor(text: string) {
    this.chars = Array.from(text);
  }

  private cur(): string | undefined {
    return this.chars[this.pos];
  }

  private error(message: string): TOMLError {
    return new TOMLError(this.line, message);
  }

  parseAll(): TOMLItem[] {
    const chars = this.chars;
    const items: TOMLItem[] = [];
    while (this.pos < chars.length) {
      const startPos = this.pos;
      const startLine = this.line;
      this.skipInlineSpaces();
      let kind: TOMLKind = { type: "trivia" };
      let value: TOMLValue | undefined;
      let valueStart = 0;
      let valueEnd = 0;
      const c = this.cur();
      if (c === undefined || c === "\n" || c === "#" || c === "\r") {
        kind = { type: "trivia" };
      } else if (c === "[") {
        if (this.peek(1) === "[") {
          this.pos += 2;
          const path = this.parseKey();
          this.skipInlineSpaces();
          this.expectChars("]]");
          kind = { type: "arrayTable", path };
        } else {
          this.pos += 1;
          const path = this.parseKey();
          this.skipInlineSpaces();
          this.expectChars("]");
          kind = { type: "table", path };
        }
      } else {
        const key = this.parseKey();
        this.skipInlineSpaces();
        this.expectChars("=");
        this.skipInlineSpaces();
        valueStart = this.pos;
        value = this.parseValue();
        valueEnd = this.pos;
        kind = { type: "keyValue", key };
      }
      // Fin de ligne : espaces, commentaire, saut de ligne.
      this.skipInlineSpaces();
      if (this.cur() === "#") {
        while (this.pos < chars.length && this.cur() !== "\n") this.pos += 1;
      }
      if (this.cur() === "\r") this.pos += 1;
      if (this.pos < chars.length) {
        if (this.cur() !== "\n") throw this.error(t("toml.unexpected_char", this.cur() as string));
        this.pos += 1;
        this.line += 1;
      }
      const raw = chars.slice(startPos, this.pos).join("");
      const item: TOMLItem = { kind, raw, line: startLine };
      if (value !== undefined) {
        // Positions comptées en scalaires, converties en unités UTF-16 de `raw`.
        const lo = chars.slice(startPos, valueStart).join("").length;
        const hi = lo + chars.slice(valueStart, valueEnd).join("").length;
        item.value = value;
        item.valueRange = [lo, hi];
      }
      items.push(item);
    }
    return items;
  }

  private peek(offset: number): string | undefined {
    return this.chars[this.pos + offset];
  }

  private skipInlineSpaces(): void {
    while (this.cur() === " " || this.cur() === "\t") this.pos += 1;
  }

  /** Espaces, sauts de ligne et commentaires (dans les tableaux). */
  private skipSpacesAndComments(): void {
    while (this.pos < this.chars.length) {
      const c = this.cur();
      if (c === " " || c === "\t" || c === "\r") this.pos += 1;
      else if (c === "\n") {
        this.pos += 1;
        this.line += 1;
      } else if (c === "#") {
        while (this.pos < this.chars.length && this.cur() !== "\n") this.pos += 1;
      } else break;
    }
  }

  private expectChars(s: string): void {
    for (const ch of s) {
      if (this.cur() !== ch) throw this.error(t("toml.expected", s));
      this.pos += 1;
    }
  }

  private parseKey(): string[] {
    const parts: string[] = [];
    while (true) {
      this.skipInlineSpaces();
      const c = this.cur();
      if (c === undefined) throw this.error(t("toml.key_expected"));
      if (c === '"') parts.push(this.parseBasicString());
      else if (c === "'") parts.push(this.parseLiteralString());
      else {
        let s = "";
        while (isAsciiKeyChar(this.cur())) {
          s += this.cur();
          this.pos += 1;
        }
        if (s === "") throw this.error(t("toml.invalid_key"));
        parts.push(s);
      }
      this.skipInlineSpaces();
      if (this.cur() === ".") {
        this.pos += 1;
        continue;
      }
      return parts;
    }
  }

  private parseValue(): TOMLValue {
    const c = this.cur();
    if (c === undefined) throw this.error(t("toml.value_expected"));
    switch (c) {
      case '"':
        if (this.peek(1) === '"' && this.peek(2) === '"') throw this.error(t("toml.multiline"));
        return TOML.string(this.parseBasicString());
      case "'":
        if (this.peek(1) === "'" && this.peek(2) === "'") throw this.error(t("toml.multiline"));
        return TOML.string(this.parseLiteralString());
      case "[": {
        this.pos += 1;
        const values: TOMLValue[] = [];
        while (true) {
          this.skipSpacesAndComments();
          if (this.cur() === undefined) throw this.error(t("toml.array_unclosed"));
          if (this.cur() === "]") {
            this.pos += 1;
            return TOML.array(values);
          }
          values.push(this.parseValue());
          this.skipSpacesAndComments();
          if (this.cur() === undefined) throw this.error(t("toml.array_unclosed"));
          if (this.cur() === ",") {
            this.pos += 1;
            continue;
          }
          if (this.cur() === "]") {
            this.pos += 1;
            return TOML.array(values);
          }
          throw this.error(t("toml.array_separator"));
        }
      }
      case "{": {
        this.pos += 1;
        const pairs: Array<[string, TOMLValue]> = [];
        this.skipInlineSpaces();
        if (this.cur() === "}") {
          this.pos += 1;
          return TOML.inlineTable([]);
        }
        while (true) {
          const key = this.parseKey();
          if (key.length !== 1) throw this.error(t("toml.inline_dotted"));
          const k = key[0] as string;
          this.skipInlineSpaces();
          this.expectChars("=");
          this.skipInlineSpaces();
          const v = this.parseValue();
          if (pairs.some(([x]) => x === k)) throw this.error(t("toml.duplicate_key", k));
          pairs.push([k, v]);
          this.skipInlineSpaces();
          if (this.cur() === undefined) throw this.error(t("toml.inline_unclosed"));
          if (this.cur() === ",") {
            this.pos += 1;
            this.skipInlineSpaces();
            continue;
          }
          if (this.cur() === "}") {
            this.pos += 1;
            return TOML.inlineTable(pairs);
          }
          throw this.error(t("toml.inline_separator"));
        }
      }
      case "t":
        this.expectChars("true");
        return TOML.bool(true);
      case "f":
        this.expectChars("false");
        return TOML.bool(false);
      default:
        return this.parseNumber();
    }
  }

  private parseNumber(): TOMLValue {
    let s = "";
    for (let c = this.cur(); c !== undefined && isNumberChar(c); c = this.cur()) {
      s += this.cur();
      this.pos += 1;
    }
    if (s === "") throw this.error(t("toml.invalid_value"));
    // Dates et heures (1979-05-27, 07:32:00) : non prises en charge.
    if (s.includes(":") || /^\d{4}-\d{2}/.test(s)) throw this.error(t("toml.dates"));
    const clean = s.replaceAll("_", "");
    if (clean.includes(".") || clean.toLowerCase().includes("e")) {
      // Comme `Double(String)` : chiffres ASCII, point et exposant optionnels.
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(clean)) throw this.error(t("toml.invalid_number", s));
      return TOML.double(Number(clean));
    }
    // Comme `Int64(String)` : signe optionnel, chiffres ASCII, dans les bornes d'un entier 64 bits.
    if (!/^[+-]?\d+$/.test(clean)) throw this.error(t("toml.invalid_number", s));
    const big = BigInt(clean);
    if (big > 9223372036854775807n || big < -9223372036854775808n) throw this.error(t("toml.invalid_number", s));
    return TOML.integer(Number(big));
  }

  private parseBasicString(): string {
    this.pos += 1;
    let out = "";
    while (this.pos < this.chars.length) {
      const c = this.cur() as string;
      if (c === '"') {
        this.pos += 1;
        return out;
      }
      if (c === "\n") break;
      if (c === "\\") {
        const n = this.peek(1);
        if (n === undefined) break;
        this.pos += 2;
        switch (n) {
          case "n":
            out += "\n";
            break;
          case "t":
            out += "\t";
            break;
          case "r":
            out += "\r";
            break;
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "b":
            out += "\u{08}";
            break;
          case "f":
            out += "\u{0C}";
            break;
          case "u":
          case "U": {
            const len = n === "u" ? 4 : 8;
            const hex = this.chars.slice(this.pos, this.pos + len).join("");
            const code =
              /^[0-9A-Fa-f]+$/.test(hex) && this.pos + len <= this.chars.length ? Number.parseInt(hex, 16) : NaN;
            // Scalaire Unicode valide : pas de demi-codet de substitution, au plus U+10FFFF.
            if (Number.isNaN(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
              throw this.error(t("toml.unicode_escape"));
            }
            out += String.fromCodePoint(code);
            this.pos += len;
            break;
          }
          default:
            throw this.error(t("toml.escape", `\\${n}`));
        }
        continue;
      }
      out += c;
      this.pos += 1;
    }
    throw this.error(t("toml.string_unclosed"));
  }

  private parseLiteralString(): string {
    this.pos += 1;
    let out = "";
    while (this.pos < this.chars.length) {
      const c = this.cur() as string;
      if (c === "'") {
        this.pos += 1;
        return out;
      }
      if (c === "\n") break;
      out += c;
      this.pos += 1;
    }
    throw this.error(t("toml.string_unclosed"));
  }
}
