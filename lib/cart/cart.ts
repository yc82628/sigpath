/**
 * lib/cart/cart.ts — the shopping cart, with no account.
 *
 * WHERE IT LIVES
 * In the shopper's own browser (localStorage), like the price alerts' opt-in:
 * SigPath has no accounts, so there is no server-side cart to sign in to, and
 * nothing about what someone is thinking of buying is stored on SigPath's side.
 *
 * WHAT AN ITEM IS
 * A snapshot of a search result when it was added: what it is, where it's
 * sold, its price then, and its verdict then. The cart page asks the
 * marketplace for the price NOW every time it opens (lib/cart/refresh.ts), so
 * what it shows is current, and says when the price changed, the listing
 * ended or it sold out. The verdict is labelled as of when it was added: a
 * new verdict needs a new comparison, which is a new search.
 *
 * PAYING
 * Item by item: each seller ships separately, and SigPath's escrow protects
 * each order on its own. "Pay with USDC" is offered only while the signed
 * quote from the search is valid and the price hasn't moved; otherwise the
 * shopper checks it again (a fresh search, a fresh quote).
 *
 * Pure functions, no browser or Node APIs: the same code runs in both, and in
 * the tests.
 */

import type { Money } from "../marketplace/types";

export const CART_MAX_ITEMS = 30;
/** An item nobody has looked at for this long is dropped. */
export const CART_TTL_MS = 30 * 24 * 3600 * 1000;
export const CART_STORAGE_KEY = "sigpath-cart-v1";

export type CartVerdict = "checked" | "caution" | "unchecked";

export interface CartItem {
  /** listingKey: "<source>:<id>". */
  key: string;
  source: string;
  id: string;
  title: string;
  url: string;
  imageUrl?: string;
  condition: string;
  seller: string;
  /** When it was added. */
  price: Money;
  shipping?: Money;
  verdict: CartVerdict;
  headline: string;
  /** The search's signed quote, if it offered SigPath checkout. Expires (ms). */
  quote?: { token: string; usdc?: string; expiresAt: number };
  addedAt: number;
  /** Ticked off on the "Buy on eBay" checklist: the shopper bought it there. */
  bought?: boolean;
}

const money = (m: unknown): m is Money =>
  !!m && typeof m === "object" && Number.isInteger((m as Money).amount) && (m as Money).amount >= 0 && /^[A-Z]{3}$/.test(String((m as Money).currency));

/** Whatever is in storage, reduced to the items that are well formed. Never throws. */
export function parseCart(raw: string | null | undefined): CartItem[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: CartItem[] = [];
  for (const it of data) {
    if (!it || typeof it !== "object") continue;
    const c = it as CartItem;
    if (typeof c.key !== "string" || typeof c.source !== "string" || typeof c.id !== "string") continue;
    if (c.key !== `${c.source}:${c.id}` || seen.has(c.key)) continue;
    if (typeof c.title !== "string" || typeof c.url !== "string" || !/^https:\/\//.test(c.url)) continue;
    if (!money(c.price) || (c.shipping !== undefined && !money(c.shipping))) continue;
    if (!["checked", "caution", "unchecked"].includes(c.verdict) || typeof c.addedAt !== "number") continue;
    if (c.bought !== undefined && typeof c.bought !== "boolean") continue;
    seen.add(c.key);
    out.push(c);
    if (out.length >= CART_MAX_ITEMS) break;
  }
  return out;
}

export type AddResult = { ok: true; cart: CartItem[] } | { ok: false; reason: string };

export function addItem(cart: CartItem[], item: CartItem): AddResult {
  if (cart.some((c) => c.key === item.key)) return { ok: true, cart };
  if (cart.length >= CART_MAX_ITEMS) return { ok: false, reason: `The cart holds up to ${CART_MAX_ITEMS} items. Remove one to add another.` };
  return { ok: true, cart: [...cart, item] };
}

export function removeItem(cart: CartItem[], key: string): CartItem[] {
  return cart.filter((c) => c.key !== key);
}

export function setBought(cart: CartItem[], key: string, bought: boolean): CartItem[] {
  return cart.map((c) => (c.key === key ? { ...c, bought } : c));
}

/** A fresh quote from the cart's re-check (lib/cart/requote.ts) replaces the old one. */
export function setQuote(cart: CartItem[], key: string, quote: NonNullable<CartItem["quote"]>): CartItem[] {
  return cart.map((c) => (c.key === key ? { ...c, quote } : c));
}

/** Items SigPath's USDC checkout can try to cover: SigPath-checked, from a marketplace it buys on. */
export function checkoutCandidates(cart: CartItem[]): CartItem[] {
  return cart.filter((c) => c.verdict === "checked" && !c.bought && (c.source === "ebay" || c.source === "stub"));
}

/** Does this item's quote still have time left (with a margin for filling in the form)? */
export function quoteFresh(c: CartItem, nowMs = Date.now(), marginMs = 3 * 60 * 1000): boolean {
  return !!c.quote && c.quote.expiresAt - nowMs > marginMs;
}

/** Drop what's past its time. */
export function prune(cart: CartItem[], now = Date.now()): CartItem[] {
  return cart.filter((c) => now - c.addedAt < CART_TTL_MS);
}

/** The price now, as the cart page learned it (lib/cart/refresh.ts). */
export type Freshness =
  | { status: "ok" | "sold_out"; price: Money; shipping?: Money }
  | { status: "gone" }
  /** Couldn't ask: a demo listing, a marketplace SigPath can't price, eBay down, or the limit reached. */
  | { status: "unchecked"; reason: string };

export const itemTotal = (price: Money, shipping?: Money): Money => ({
  amount: price.amount + (shipping && shipping.currency === price.currency ? shipping.amount : 0),
  currency: price.currency,
});

/** Did the price (with shipping) change since the item was added? */
export function priceMoved(item: CartItem, now: Freshness | undefined): boolean {
  if (!now || (now.status !== "ok" && now.status !== "sold_out")) return false;
  const a = itemTotal(item.price, item.shipping), b = itemTotal(now.price, now.shipping);
  return a.currency !== b.currency || a.amount !== b.amount;
}

/** Can the cart offer SigPath's USDC checkout for this item right now? */
export function canPayNow(item: CartItem, now: Freshness | undefined, nowMs = Date.now()): boolean {
  if (!item.quote || nowMs >= item.quote.expiresAt) return false;
  if (now?.status === "gone" || now?.status === "sold_out") return false;
  return !priceMoved(item, now);
}

/**
 * What the cart adds up to, per currency: the price now where it's known,
 * else the price when added. Ended and sold-out items don't count.
 */
export function totals(cart: CartItem[], fresh: Record<string, Freshness | undefined> = {}): Money[] {
  const sum = new Map<string, number>();
  for (const c of cart) {
    const f = fresh[c.key];
    if (f?.status === "gone" || f?.status === "sold_out") continue;
    const t = f?.status === "ok" ? itemTotal(f.price, f.shipping) : itemTotal(c.price, c.shipping);
    sum.set(t.currency, (sum.get(t.currency) ?? 0) + t.amount);
  }
  return [...sum].map(([currency, amount]) => ({ amount, currency }));
}
