// Traductions (en-US, fr-FR), portées depuis L10n.swift. Catalogues `locales/{en,fr}.json`, produits une fois depuis
// les `.strings`/`.stringsdict` par `scripts/convert-locales.ts` : jetons positionnels `{1}`, `{2}`… à la place des
// spécificateurs printf, pluriels choisis par `Intl.PluralRules` sur l'argument numérique.
import enCatalog from "../../locales/en.json" with { type: "json" };
import frCatalog from "../../locales/fr.json" with { type: "json" };

export type AppLanguage = "en-US" | "fr-FR";
/** Valeur de `language` dans `config.toml` ou de `--lang` : `auto` suit le système. */
export type LanguageSetting = AppLanguage | "auto";

export const appLanguages: readonly AppLanguage[] = ["en-US", "fr-FR"];

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
type CompositeEntry = { format: string; plurals: Record<string, PluralForms> };
/** Texte simple, pluriel sur l'argument 1, ou format dont certains jetons `{N}` sont des pluriels sur l'argument N. */
export type CatalogEntry = string | PluralForms | CompositeEntry;
export type Catalog = Readonly<Record<string, CatalogEntry>>;

const catalogs: Record<AppLanguage, Catalog> = {
  "en-US": enCatalog as Catalog,
  "fr-FR": frCatalog as Catalog,
};

let current: AppLanguage = "en-US";

export function currentLanguage(): AppLanguage {
  return current;
}

export function setLanguage(language: AppLanguage): void {
  current = language;
}

/** `en`, `en-US`, `en_US`, `fr`, `fr-FR`, `fr_FR` (casse ignorée) ; `undefined` sinon, `auto` compris. */
export function parseLanguage(value: string | null | undefined): AppLanguage | undefined {
  switch (value?.toLowerCase()) {
    case "en":
    case "en-us":
    case "en_us":
      return "en-US";
    case "fr":
    case "fr-fr":
    case "fr_fr":
      return "fr-FR";
    default:
      return undefined;
  }
}

/** Valeur de `--lang` ou de `config.toml` : `auto` (exactement) ou une langue ; `undefined` si elle est invalide. */
export function parseLanguageSetting(value: string): LanguageSetting | undefined {
  return value === "auto" ? "auto" : parseLanguage(value);
}

/** Langue du système : la première langue préférée prise en charge (`fr*` → fr-FR, `en*` → en-US), sinon en-US. */
export function systemLanguage(preferredLanguages: readonly string[]): AppLanguage {
  for (const code of preferredLanguages) {
    const lang = code.toLowerCase();
    if (lang.startsWith("fr")) return "fr-FR";
    if (lang.startsWith("en")) return "en-US";
  }
  return "en-US";
}

/** Langue effective : valeur explicite reconnue, sinon (`auto`, absente ou invalide) celle du système. */
export function resolveLanguage(
  setting: string | null | undefined,
  preferredLanguages: readonly string[],
): AppLanguage {
  return parseLanguage(setting) ?? systemLanguage(preferredLanguages);
}

/** Langues préférées vues par le runtime ; le main Electron passe plutôt `app.getPreferredSystemLanguages()`. */
function runtimeLanguages(): string[] {
  return [Intl.DateTimeFormat().resolvedOptions().locale];
}

/** Choisit la langue active (équivalent de `L10n.configure(explicit:)`). */
export function configureLanguage(
  setting: string | null | undefined,
  preferredLanguages: readonly string[] = runtimeLanguages(),
): AppLanguage {
  current = resolveLanguage(setting, preferredLanguages);
  return current;
}

/** Catalogue d'une langue (contrôles de parité). */
export function catalog(language: AppLanguage): Catalog {
  return catalogs[language];
}

/** Clés au pluriel d'une langue. */
export function pluralKeys(language: AppLanguage): string[] {
  return Object.entries(catalogs[language])
    .filter(([, entry]) => typeof entry !== "string")
    .map(([key]) => key);
}

/** Clés de `keys` absentes d'au moins un des deux catalogues. */
export function missingKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => appLanguages.some((language) => !(key in catalogs[language])));
}

/** Repli : langue demandée, puis anglais, puis la clé elle-même. `lookup` est remplaçable dans les tests. */
export function resolve<T>(
  key: string,
  language: AppLanguage,
  lookup: (key: string, language: AppLanguage) => T | undefined,
): T | string {
  return lookup(key, language) ?? (language === "en-US" ? undefined : lookup(key, "en-US")) ?? key;
}

function lookupEntry(key: string, language: AppLanguage): CatalogEntry | undefined {
  const table = catalogs[language];
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const pluralRules = new Map<AppLanguage, Intl.PluralRules>();

function selectForm(forms: PluralForms, value: string | number | undefined, language: AppLanguage): string {
  let rules = pluralRules.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(language);
    pluralRules.set(language, rules);
  }
  const n = Number(value);
  return Number.isFinite(n) ? (forms[rules.select(n)] ?? forms.other) : forms.other;
}

const token = /\{(\d+)\}/g;

/** Modèle d'une entrée, pluriels résolus : il ne reste que des jetons d'arguments `{N}`. */
function template(entry: CatalogEntry, args: ReadonlyArray<string | number>, language: AppLanguage): string {
  if (typeof entry === "string") return entry;
  if (!("format" in entry)) return selectForm(entry as PluralForms, args[0], language);
  const { format, plurals } = entry as CompositeEntry;
  return format.replace(token, (match, index: string) => {
    const forms = plurals[index];
    return forms ? selectForm(forms, args[Number(index) - 1], language) : match;
  });
}

/** Texte traduit de `key` ; les arguments remplacent les jetons `{1}`, `{2}`… (anciens `%@`, `%lld`, `%1$@`…). */
export function t(key: string, ...args: Array<string | number>): string {
  const language = current;
  const entry = resolve(key, language, lookupEntry);
  const text = template(entry, args, language);
  if (args.length === 0) return text;
  // Un seul passage : un argument qui contient `{2}` n'est pas réinterprété.
  return text.replace(token, (match, index: string) => {
    const arg = args[Number(index) - 1];
    return arg === undefined ? match : String(arg);
  });
}
