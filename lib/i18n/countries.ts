/**
 * lib/i18n/countries.ts — a country's name in the page's language.
 *
 * The VIES register's codes are ISO 3166 except Greece (EL) and Northern
 * Ireland (XI). English pages keep lib/sellers/business.ts's own names.
 */

import type { Lang } from "./lang";

/** The VIES register's countries (its codes), with their English names. No server code, so the browser can load it. */
export const VIES_COUNTRIES: Record<string, string> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", CY: "Cyprus", CZ: "Czechia", DE: "Germany", DK: "Denmark",
  EE: "Estonia", EL: "Greece", ES: "Spain", FI: "Finland", FR: "France", HR: "Croatia", HU: "Hungary",
  IE: "Ireland", IT: "Italy", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", MT: "Malta", NL: "Netherlands",
  PL: "Poland", PT: "Portugal", RO: "Romania", SE: "Sweden", SI: "Slovenia", SK: "Slovakia", XI: "Northern Ireland",
};

const names = new Map<Lang, Intl.DisplayNames>();

export function countryName(code: string | undefined, english: string | undefined, lang: Lang): string | undefined {
  if (lang === "en" || !code) return english;
  if (code === "XI") return "Nordirland";
  let n = names.get(lang);
  if (!n) names.set(lang, (n = new Intl.DisplayNames([lang], { type: "region" })));
  try {
    return n.of(code === "EL" ? "GR" : code) ?? english;
  } catch {
    return english;
  }
}
