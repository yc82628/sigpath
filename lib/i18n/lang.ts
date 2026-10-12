/**
 * lib/i18n/lang.ts — which language a page is shown in.
 *
 * English unless the shopper picks Deutsch with the switch in the header. The
 * choice is kept in one cookie (sigpath-lang), so pages are rendered in it
 * from the first byte; it holds only "de" or "en", and the privacy page says
 * so. Shopper pages are translated (home, search with every verdict and check,
 * cart, checkout, price check, How it works, alerts, Ai-chan); seller,
 * business, developer and legal pages stay English for now.
 */

export type Lang = "en" | "de";
export const LANGS: Lang[] = ["en", "de"];
export const LANG_COOKIE = "sigpath-lang";
/** A year: a preference, not a session. */
export const LANG_COOKIE_MAX_AGE = 365 * 24 * 3600;

export function pickLang(cookieValue: string | undefined | null): Lang {
  return cookieValue === "de" ? "de" : "en";
}
