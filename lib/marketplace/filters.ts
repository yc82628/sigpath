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
import { VARIANT_WORDS, type Identity } from "./identity";
import { listingKey, totalPrice, type Listing, type Money } from "./types";

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
  /** Only listings whose shipping is known to be free. */
  freeShipping: boolean;
  /**
   * The exact model, from the words after the searched name (identity.ts):
   * "pro-max" for an iPhone 15 Pro Max in an "iPhone 15" search, "base" for
   * the plain one. A listing whose model can't be read never matches.
   */
  model: string | null;
  /** Specs read from the title; a listing that doesn't state one never matches it. */
  storage: number | null;
  ram: number | null;
  gen: number | null;
  sort: SortOrder;
}

export const NO_FILTERS: Filters = {
  condition: "any",
  market: null,
  min: null,
  max: null,
  checkedOnly: false,
  productsOnly: false,
  freeShipping: false,
  model: null,
  storage: null,
  ram: null,
  gen: null,
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

/** A whole number in a range, or null: "256" -> 256, "abc" or "0" -> null. */
function whole(v: string | undefined, max: number): number | null {
  const n = Number((v ?? "").trim());
  return /^\d{1,6}$/.test((v ?? "").trim()) && n >= 1 && n <= max ? n : null;
}

/**
 * A listing's model as a filter value: its variant words in the order people
 * say them ("pro-max", not "max-pro"), "base" for none, null when unknown.
 */
export function modelKey(i: Identity | undefined): string | null {
  if (!i || i.kind !== "product" || i.named === false || i.variant === undefined) return null;
  if (!i.variant.length) return "base";
  return [...i.variant].sort((a, b) => VARIANT_WORDS.indexOf(a) - VARIANT_WORDS.indexOf(b)).join("-");
}

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
    freeShipping: one(params.ship) === "free",
    model: /^(base|[a-z]{2,10}(-[a-z]{2,10}){0,2})$/.test(one(params.model) ?? "") ? one(params.model)! : null,
    storage: whole(one(params.storage), 65536),
    ram: whole(one(params.ram), 1024),
    gen: whole(one(params.gen), 99),
    sort: sort === "price" || sort === "price-desc" ? sort : "best",
  };
}

/** Whether anything narrows or reorders the results. */
export function isFiltered(f: Filters): boolean {
  return (
    f.condition !== "any" ||
    f.market !== null ||
    f.min !== null ||
    f.max !== null ||
    f.checkedOnly ||
    f.productsOnly ||
    f.freeShipping ||
    f.model !== null ||
    f.storage !== null ||
    f.ram !== null ||
    f.gen !== null ||
    f.sort !== "best"
  );
}

/** How many filters narrow the results (sort isn't one): the number on the phone's "Filter" button. */
export function activeCount(f: Filters): number {
  return [
    f.condition !== "any",
    f.market !== null,
    f.min !== null || f.max !== null,
    f.checkedOnly,
    f.productsOnly,
    f.freeShipping,
    f.model !== null,
    f.storage !== null,
    f.ram !== null,
    f.gen !== null,
  ].filter(Boolean).length;
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
  if (f.freeShipping) p.set("ship", "free");
  if (f.model) p.set("model", f.model);
  if (f.storage !== null) p.set("storage", String(f.storage));
  if (f.ram !== null) p.set("ram", String(f.ram));
  if (f.gen !== null) p.set("gen", String(f.gen));
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
    const id = identities[listingKey(l)];
    if (f.productsOnly && (id?.kind === "accessory" || id?.kind === "parts")) return false;
    if (f.freeShipping && !(l.shipping && l.shipping.amount === 0)) return false;
    if (f.model !== null && modelKey(id) !== f.model) return false;
    if (f.storage !== null && id?.storageGB !== f.storage) return false;
    if (f.ram !== null && id?.ramGB !== f.ram) return false;
    if (f.gen !== null && id?.generation !== f.gen) return false;
    const total = totalPrice(l).amount;
    if (f.min !== null && total < f.min) return false;
    if (f.max !== null && total > f.max) return false;
    return true;
  });
  if (f.sort === "best") return shown;
  const dir = f.sort === "price" ? 1 : -1;
  return [...shown].sort((a, b) => dir * (totalPrice(a).amount - totalPrice(b).amount));
}

export interface FacetOption<V> {
  value: V;
  count: number;
}

/** One exact model in a search: the cards above the results. */
export interface ModelCard {
  key: string;
  variant: string[];
  count: number;
  /** The cheapest SigPath-checked offer, or null when none of them is checked. */
  from: Money | null;
  /** The storage sizes it's offered in, smallest first. */
  storages: number[];
}

export interface Facets {
  condition: Record<ConditionFilter, number>;
  market: FacetOption<string>[];
  storage: FacetOption<number>[];
  ram: FacetOption<number>[];
  gen: FacetOption<number>[];
  freeShipping: number;
  models: ModelCard[];
}

/**
 * The choices the sidebar offers, each with how many listings it would show.
 * Each count applies every OTHER filter (as shops count): with "used" chosen,
 * the storage sizes count used listings, and "new" still says how many new
 * ones there are. A spec appears only when the listings state at least two
 * different values: one size for everything is nothing to choose between.
 */
export function facets<L extends Listing>(
  listings: L[],
  f: Filters,
  labelOf: (l: L) => CheckLabel,
  identities: Record<string, Identity>,
): Facets {
  const without = (patch: Partial<Filters>) => applyFilters(listings, { ...f, ...patch, sort: "best" }, labelOf, identities);
  const idOf = (l: L) => identities[listingKey(l)];
  const tally = <V extends string | number>(ls: L[], pick: (l: L) => V | null | undefined): FacetOption<V>[] => {
    const counts = new Map<V, number>();
    for (const l of ls) {
      const v = pick(l);
      if (v !== null && v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts].map(([value, count]) => ({ value, count }));
  };
  const spec = (ls: L[], pick: (i: Identity) => number | undefined) => {
    const opts = tally(ls, (l) => {
      const i = idOf(l);
      return i?.kind === "product" ? pick(i) : undefined;
    }).sort((a, b) => a.value - b.value);
    return opts.length >= 2 ? opts : [];
  };

  const byCondition = without({ condition: "any" });
  const condition: Record<ConditionFilter, number> = {
    any: byCondition.length,
    new: byCondition.filter((l) => l.condition === "new").length,
    refurbished: byCondition.filter((l) => l.condition === "refurbished").length,
    used: byCondition.filter((l) => l.condition === "used").length,
  };

  const byModel = without({ model: null });
  const groups = new Map<string, L[]>();
  for (const l of byModel) {
    const key = modelKey(idOf(l));
    if (key) groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const models: ModelCard[] = [...groups]
    .map(([key, ls]) => {
      const checked = ls.filter((l) => labelOf(l).verdict === "checked").map((l) => totalPrice(l));
      const from = checked.length ? checked.reduce((a, b) => (b.amount < a.amount ? b : a)) : null;
      const storages = [...new Set(ls.map((l) => idOf(l)?.storageGB).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
      return { key, variant: key === "base" ? [] : key.split("-"), count: ls.length, from, storages };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    condition,
    market: tally(without({ market: null }), (l) => l.source).sort((a, b) => b.count - a.count),
    storage: spec(without({ storage: null }), (i) => i.storageGB),
    ram: spec(without({ ram: null }), (i) => i.ramGB),
    gen: spec(without({ gen: null }), (i) => i.generation),
    freeShipping: without({ freeShipping: false }).filter((l) => l.shipping && l.shipping.amount === 0).length,
    // Cards only when there's a choice: one model, or none readable, is nothing to pick from.
    models: models.length >= 2 ? models : [],
  };
}
