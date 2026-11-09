// Dates relatives et heures dans la langue active (équivalents de `RelativeDateTimeFormatter` et du format court de
// l'heure de la 0.8.0), partagées par l'accueil, les réglages et la barre des menus.
import { currentLanguage } from "../../../core/l10n.ts";

/** Date reçue du main : `Date` (clonage structuré), nombre de millisecondes ou texte ISO. */
export function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** « il y a 3 heures », « in 2 days » ; `sentence` met une majuscule au début (« Il y a 3 heures »). */
export function relativeDate(value: Date | number | string, sentence = false, now: Date = new Date()): string {
  const seconds = (toDate(value).getTime() - now.getTime()) / 1000;
  const format = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: "auto" });
  let text = format.format(0, "second");
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) {
      text = format.format(Math.round(seconds / size), unit);
      break;
    }
  }
  return sentence ? text.charAt(0).toLocaleUpperCase(currentLanguage()) + text.slice(1) : text;
}

/** Heure courte : « 12:30 », « 12:30 PM ». */
export function timeOfDay(value: Date | number | string): string {
  return new Intl.DateTimeFormat(currentLanguage(), { hour: "numeric", minute: "2-digit" }).format(toDate(value));
}

export function isToday(value: Date | number | string, now: Date = new Date()): boolean {
  return toDate(value).toDateString() === now.toDateString();
}

/** Dernier élément d'un chemin (`/Volumes/workspaces` → `workspaces`). */
export function baseName(p: string): string {
  return p.split("/").filter(Boolean).at(-1) ?? p;
}

/** Chemin abrégé avec `~` pour le dossier personnel (`/Users/demo/Documents` → `~/Documents`). */
export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/**
 * Libellé de `SettingsRow` : espaces insécables, car `MiddleText` coupe le texte en deux éléments et l'espace au bord
 * de la coupe disparaît (« updatesautomatically »).
 */
export function rowLabel(text: string): string {
  return text.replace(/ /g, "\u00a0");
}
