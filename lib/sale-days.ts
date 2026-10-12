/**
 * lib/sale-days.ts — the big sale days, when SigPath says "check before you pay".
 *
 * WHY
 * Scams follow the shoppers. Verbraucherzentrale Niedersachsen (5 December
 * 2024): with order volumes rising around Black Friday, Cyber Monday and
 * Christmas, "so does the risk of falling for dubious shops". So on those days
 * the site says so at the top of every page. It changes no verdict: the checks
 * are the same every day of the year.
 *
 * WHICH DAYS
 * The German calendar SigPath launches on: 11.11, then Black Week (the Monday
 * before Black Friday to Cyber Monday). A market with other peaks (the 9.9,
 * 10.10 and 12.12 sales in Southeast Asia) adds its own entries here.
 *
 * Dates are taken in German time (Europe/Berlin), the shoppers' own day.
 */

export type SaleDayId = "singles-day" | "black-week" | "black-friday" | "cyber-monday";

export interface SaleDay {
  id: SaleDayId;
  /** What the banner says. Every one ends with what to do. */
  message: string;
}

/** The same lines in German, for the Deutsch version of the site. */
export const MESSAGES_DE: Record<SaleDayId, string> = {
  "singles-day": "11.11: Große Rabatttage ziehen auch Betrüger an. Prüfe jedes Angebot, bevor du zahlst.",
  "black-week": "Black Week: Verbraucherzentralen warnen rund um die großen Sales vor Fake-Shops. Prüfe jedes Angebot, bevor du zahlst.",
  "black-friday": "Black Friday: Mit jeder Bestellung steigt das Risiko von Fake-Shops. Prüfe jedes Angebot, bevor du zahlst.",
  "cyber-monday": "Cyber Monday: Auch der letzte große Rabatttag zieht Betrüger an. Prüfe jedes Angebot, bevor du zahlst.",
};

const MESSAGES: Record<SaleDayId, string> = {
  "singles-day": "11.11: big sale days draw scammers too. Check every deal before you pay.",
  "black-week": "Black Week: consumer centres warn of fake shops around the big sales. Check every deal before you pay.",
  "black-friday": "Black Friday: the risk of fake shops rises with every order. Check every deal before you pay.",
  "cyber-monday": "Cyber Monday: the last big sale day draws scammers too. Check every deal before you pay.",
};

/** Black Friday: the day after the fourth Thursday of November. Returns the day of the month. */
export function blackFriday(year: number): number {
  const firstWeekday = new Date(Date.UTC(year, 10, 1)).getUTCDay(); // 0 = Sunday
  const firstThursday = 1 + ((4 - firstWeekday + 7) % 7);
  return firstThursday + 21 + 1;
}

/** The sale day a calendar date falls on, or null. `month` is 1–12. */
export function saleDayOn(year: number, month: number, day: number): SaleDay | null {
  const of = (id: SaleDayId): SaleDay => ({ id, message: MESSAGES[id] });
  if (month === 11 && day === 11) return of("singles-day");
  const bf = blackFriday(year);
  // Black Week: Monday (bf - 4) to Cyber Monday (bf + 3), which can fall in December.
  const start = Date.UTC(year, 10, bf - 4);
  const today = Date.UTC(year, month - 1, day);
  const offset = Math.round((today - start) / 86_400_000);
  if (offset < 0 || offset > 7) return null;
  if (offset === 4) return of("black-friday");
  if (offset === 7) return of("cyber-monday");
  return of("black-week");
}

/** Today's date in German time. */
export function berlinDate(now: Date = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** For showing a banner on a day that isn't one (a demo): `?saleday=black-friday`. */
export function saleDayPreview(param: string | null): SaleDay | null {
  return param && Object.prototype.hasOwnProperty.call(MESSAGES, param)
    ? { id: param as SaleDayId, message: MESSAGES[param as SaleDayId] }
    : null;
}
