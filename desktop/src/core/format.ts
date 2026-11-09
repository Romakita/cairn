// Formats régionaux selon la langue active, portés depuis `Fmt` (L10n.swift). Les sorties reproduisent celles de
// Foundation en en-US et fr-FR (arrondi au pair le plus proche, espaces fines du français) ; les dates et les durées
// sont composées ici plutôt que par `Intl`, dont le rendu change selon la version d'ICU (Bun, Node d'Electron).
import { type AppLanguage, currentLanguage } from "./l10n.ts";

const formatters = new Map<string, Intl.NumberFormat>();

function numberFormat(language: AppLanguage, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const id = `${language}|${JSON.stringify(options)}`;
  let f = formatters.get(id);
  if (!f) {
    f = new Intl.NumberFormat(language, { roundingMode: "halfEven", ...options });
    formatters.set(id, f);
  }
  return f;
}

function fractionDigits(language: AppLanguage, v: number, min: number, max: number): string {
  return numberFormat(language, { minimumFractionDigits: min, maximumFractionDigits: max }).format(v);
}

const byteUnits: Record<AppLanguage, string[]> = {
  "en-US": ["bytes", "KB", "MB", "GB", "TB", "PB"],
  "fr-FR": ["o", "ko", "Mo", "Go", "To", "Po"],
};

/** Tailles en unités décimales (comme le Finder) : « 1,23 Go » en français, « 1.23 GB » en anglais. */
function bytes(b: number): string {
  const language = currentLanguage();
  const units = byteUnits[language];
  if (b < 1000) return `${Math.max(Math.trunc(b), 0)} ${units[0]}`;
  let v = b;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  const maxDigits = i >= 3 ? 2 : i === 2 ? 1 : 0;
  return `${fractionDigits(language, v, 0, maxDigits)} ${units[i]}`;
}

/**
 * Part de `total` à une décimale (« 12,3 % », « 12.3% ») ou à `digits` décimales (0 : avancement, seuils) ; « – » si
 * le total est nul, « <0,1 % » (« <1 % » sans décimale) si la part est infime.
 */
function percent(part: number, total: number, digits = 1): string {
  if (!(total > 0)) return "–";
  const p = part / total;
  const format = numberFormat(currentLanguage(), {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const smallest = 10 ** -(digits + 2);
  if (p > 0 && p < smallest) return `<${number(smallest * 100, digits)} %`;
  return format.format(p);
}

/** Entier avec séparateur de milliers (« 1 234 567 », « 1,234,567 »). */
function count(n: number): string {
  return numberFormat(currentLanguage(), {}).format(n);
}

/** Nombre à `digits` décimales exactement. */
function number(v: number, digits: number): string {
  return fractionDigits(currentLanguage(), v, digits, digits);
}

const months: Record<AppLanguage, string[]> = {
  "en-US": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  "fr-FR": ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
};

/** Date et heure locales abrégées : « 9 nov. 2025 à 9:50 », « Nov 9, 2025 at 9:50 AM » (U+202F avant AM/PM). */
function date(d: Date): string {
  const language = currentLanguage();
  const month = months[language][d.getMonth()];
  const minutes = String(d.getMinutes()).padStart(2, "0");
  if (language === "fr-FR") return `${d.getDate()} ${month} ${d.getFullYear()} à ${d.getHours()}:${minutes}`;
  const hours = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return `${month} ${d.getDate()}, ${d.getFullYear()} at ${hours}:${minutes} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

/**
 * Durées : « 12,3 s » / « 12.3 s » sous la minute, puis heures, minutes et secondes abrégées, à la seconde près
 * (« 1 h, 2 min et 5 s », « 1 hr, 2 min, 5 sec ») ; les unités nulles sont omises, les heures ne passent pas aux jours.
 */
function duration(seconds: number): string {
  if (!(seconds >= 60)) return `${number(Math.max(seconds, 0) || 0, 1)} s`;
  const language = currentLanguage();
  const total = Math.round(seconds);
  const values = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const fr = language === "fr-FR";
  const units = fr ? [" h", " min", " s"] : [" hr", " min", " sec"];
  const parts = values.flatMap((v, i) => (v > 0 ? [`${count(v)}${units[i]}`] : []));
  if (!fr || parts.length < 2) return parts.join(", ");
  return `${parts.slice(0, -1).join(", ")} et ${parts.at(-1)}`;
}

/** Formats régionaux, mêmes noms que `Fmt` en Swift. */
export const Fmt = { bytes, percent, count, number, date, duration } as const;
