/**
 * lib/i18n/money.ts — prices and numbers the way each language writes them.
 *
 * English pages keep SigPath's plain "229.00 EUR". German pages write money
 * the German way, "229,00 €", and decimals with a comma. The amounts are the
 * same integers in minor units (lib/marketplace/types.ts); only the text
 * differs.
 */

import { formatMoney, type Money } from "../marketplace/types";
import type { Lang } from "./lang";

const de = new Map<string, Intl.NumberFormat>();

/** A price for display: "229.00 EUR" in English, "229,00 €" in German. */
export function moneyText(m: Money, lang: Lang): string {
  if (lang !== "de") return formatMoney(m);
  let f = de.get(m.currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat("de-DE", { style: "currency", currency: m.currency });
    } catch {
      return formatMoney(m).replace(".", ",");
    }
    de.set(m.currency, f);
  }
  // Intl puts a no-break space before the symbol: kept, so "€" never wraps away from its number.
  return f.format(m.amount / 100);
}

/** A decimal number already written with a point ("283.0383"), in the page's language. */
export function decimalText(s: string, lang: Lang): string {
  return lang === "de" ? s.replace(".", ",") : s;
}

/** Every "125.19 EUR" inside a sentence, written the German way. For the check reasons. */
export function germanMoneyInText(s: string): string {
  return s.replace(/\b(\d+)\.(\d{2}) (EUR|USD|GBP|CHF)\b/g, (_, whole: string, cents: string, cur: string) =>
    moneyText({ amount: Number(whole) * 100 + Number(cents), currency: cur }, "de"),
  );
}
