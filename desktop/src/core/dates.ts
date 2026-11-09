// Dates au format de la 0.8.0 : ISO 8601 en UTC, sans millisecondes (`2025-11-09T08:50:00Z`).
// La version Swift ne relit pas un `toISOString()` (millisecondes) : ne jamais l'écrire dans un fichier.

/** Date au format ISO 8601 de Foundation, à la seconde (tronquée), en UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Lit une date ISO 8601 (avec ou sans millisecondes) ; `null` si elle est illisible. */
export function parseISODate(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Date locale selon un motif de `DateFormatter` en `en_US_POSIX` : `yyyy`, `MM`, `dd`, `HH`, `mm`, `ss`,
 * et du texte entre apostrophes. Exemples : nom de version `yyyy-MM-dd'T'HHmmss`, journal `yyyyMMdd-HHmmss`.
 */
export function formatLocalDate(date: Date, pattern: string): string {
  const fields: Record<string, string> = {
    yyyy: pad(date.getFullYear(), 4),
    MM: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g, (match, literal: string | undefined) =>
    literal !== undefined ? literal : (fields[match] ?? match),
  );
}
