// Calendrier minimal pour la planification (équivalent du `Calendar` injecté côté Swift) : heure locale par défaut,
// UTC pour les tests. Les additions de jours gardent l'heure affichée (comme `date(byAdding: .day)`), même au
// passage à l'heure d'été.

export interface DateParts {
  year: number;
  /** 1 à 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Jour de la semaine du calendrier grégorien de Foundation : dimanche = 1, lundi = 2… samedi = 7. */
  weekday: number;
}

export interface Calendar {
  readonly id: "local" | "utc";
  parts(date: Date): DateParts;
  /** Date d'après ses composants ; les valeurs hors limites débordent (comme `calendar.date(from:)`). */
  date(parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number }): Date;
}

export const localCalendar: Calendar = {
  id: "local",
  parts: (d) => ({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    weekday: d.getDay() + 1,
  }),
  date: (p) => new Date(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0),
};

export const utcCalendar: Calendar = {
  id: "utc",
  parts: (d) => ({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay() + 1,
  }),
  date: (p) => new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0)),
};

/** `date` décalée de `days` jours à la même heure affichée (les millisecondes sont gardées). */
export function addDays(calendar: Calendar, date: Date, days: number): Date {
  const p = calendar.parts(date);
  const d = calendar.date({ ...p, day: p.day + days });
  return new Date(d.getTime() + date.getMilliseconds());
}
