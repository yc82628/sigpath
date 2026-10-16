/**
 * lib/marketplace/filters.ts — the search page's filters and sort.
 *
 * Read from the page's address (/search?q=…&cond=used&max=150&sort=price), so
 * a filtered search can be shared or bookmarked and works without JavaScript.
 * Filters only narrow what is SHOWN: every verdict is still drawn from the
 * full set of listings, so filtering to "used under 150 €" never changes which
 * listings count as checked or what the typical price is.
 */

import type { CheckLabel } from "./label";
import type { Identity } from "./identity";
import { listingKey, totalPrice, type Listing } from "./types";

export type ConditionFilter = "any" | "new" | "refurbished" | "used";
export type SortOrder = "best" | "price" | "price-desc";

export interface Filters {
  condition: ConditionFilter;
  /** A marketplace id ("ebay", "aliexpress"), or null for all. */
  market: string | null;
  /** In minor units (cents), of the search's currency. */
  min: number | null;
  max: number | null;
  checkedOnly: boolean;
  /** Hide accessories and items for parts. */
  productsOnly: boolean;
  sort: SortOrder;
}

export const NO_FILTERS: Filters = {
  condition: "any",
  market: null,
  min: null,
  max: null,
  checkedOnly: false,
  productsOnly: false,
  sort: "best",
};

/** "150", "149,99", "1.200", "1 200,50" -> cents; anything else -> null. */
export function euros(text: string | undefined): number | null {
  const t = (text ?? "").trim().replace(/[€\s]/g, "");
  if (!t || !/^\d[\d.,]*$/.test(t)) return null;
  const dec = t.match(/[.,](\d{1,2})$/);
  const whole = (dec ? t.slice(0, -dec[0].length) : t).replace(/[.,]/g, "");
  const cents = Number(whole) * 100 + (dec ? Number(dec[1].padEnd(2, "0")) : 0);
  return Number.isFinite(cents) && cents >= 0 ? cents : null;
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseFilters(params: Params): Filters {
  const cond = one(params.cond);
  const sort = one(params.sort);
  const market = one(params.market)?.trim().toLowerCase();
  let min = euros(one(params.min));
  let max = euros(one(params.max));
  // "from 300 to 100" means 100 to 300.
  if (min !== null && max !== null && min > max) [min, max] = [max, min];
  return {
    condition: cond === "new" || cond === "used" || cond === "refurbished" ? cond : "any",
    market: market && /^[a-z]{2,20}$/.test(market) ? market : null,
    min,
    max,
    checkedOnly: one(params.checked) === "1",
    productsOnly: one(params.products) === "1",
    sort: sort === "price" || sort === "price-desc" ? sort : "best",
  };
}

/** Whether anything narrows or reorders the results. */
export function isFiltered(f: Filters): boolean {
  return (
    f.condition !== "any" || f.market !== null || f.min !== null || f.max !== null || f.checkedOnly || f.productsOnly || f.sort !== "best"
  );
}

/** The address of the same search with these filters, for links (sort, reset, "show all"). */
export function filterHref(q: string, f: Filters, extra: Params = {}): string {
  const p = new URLSearchParams({ q });
  if (f.condition !== "any") p.set("cond", f.condition);
  if (f.market) p.set("market", f.market);
  if (f.min !== null) p.set("min", String(f.min / 100));
  if (f.max !== null) p.set("max", String(f.max / 100));
  if (f.checkedOnly) p.set("checked", "1");
  if (f.productsOnly) p.set("products", "1");
  if (f.sort !== "best") p.set("sort", f.sort);
  for (const [k, v] of Object.entries(extra)) {
    const s = one(v);
    if (s === undefined || s === "") p.delete(k);
    else p.set(k, s);
  }
  return `/search?${p}`;
}

/**
 * The listings to show, in order. `listings` come in the search's own order
 * (checked first, then the product before accessories and parts, cheapest
 * first): "best" keeps it, the price sorts reorder by what the buyer pays.
 */
export function applyFilters<L extends Listing>(
  listings: L[],
  f: Filters,
  labelOf: (l: L) => CheckLabel,
  identities: Record<string, Identity>,
): L[] {
  const shown = listings.filter((l) => {
    if (f.checkedOnly && labelOf(l).verdict !== "checked") return false;
    if (f.market && l.source !== f.market) return false;
    if (f.condition === "new" && l.condition !== "new") return false;
    if (f.condition === "refurbished" && l.condition !== "refurbished") return false;
    if (f.condition === "used" && l.condition !== "used") return false;
    if (f.productsOnly) {
      const kind = identities[listingKey(l)]?.kind;
      if (kind === "accessory" || kind === "parts") return false;
    }
    const total = totalPrice(l).amount;
    if (f.min !== null && total < f.min) return false;
    if (f.max !== null && total > f.max) return false;
    return true;
  });
  if (f.sort === "best") return shown;
  const dir = f.sort === "price" ? 1 : -1;
  return [...shown].sort((a, b) => dir * (totalPrice(a).amount - totalPrice(b).amount));
}
