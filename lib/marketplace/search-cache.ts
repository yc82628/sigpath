/**
 * lib/marketplace/search-cache.ts — a marketplace's answer, kept three minutes.
 *
 * The search page's filters and sort are links back to the same search, so a
 * shopper narrowing "Nintendo Switch OLED" five ways would ask eBay five times
 * for the same 50 listings, against the site's daily eBay quota. Each source's
 * answer is kept per server instance for a short while instead. Three minutes
 * is short enough that a price shown is still the price (checkout quotes and
 * re-checks it anyway), and only answers that worked are kept: a marketplace
 * that failed is asked again next time.
 *
 * Opt-in (the search page wraps its sources): tests build fake marketplaces
 * under real names, and a cache shared between them would mix their answers.
 *
 * The price check also keeps answers in the shared database (sharedSources,
 * below), so every instance and every shopper benefits.
 */

import { createHash } from "crypto";
import { UpstashKv, type Kv } from "../kv/upstash";
import type { MarketplaceSource } from "./sources/types";
import type { SearchOptions, SourceResult } from "./types";

export const SEARCH_CACHE_SECS = 180;
const MAX_ENTRIES = 300;

const kept = new Map<string, { at: number; result: Promise<SourceResult> }>();

function keyOf(source: string, query: string, opts: SearchOptions): string {
  return JSON.stringify([source, query.trim().toLowerCase(), opts.limit ?? null, opts.currency ?? null]);
}

/** The same sources, answering a repeat of a recent search from what they said then. */
export function cachedSources(sources: MarketplaceSource[], now: () => number = Date.now): MarketplaceSource[] {
  return sources.map((s) => ({
    ...s,
    id: s.id,
    priceComparable: s.priceComparable,
    search: (query: string, opts: SearchOptions = {}) => {
      const key = keyOf(s.id, query, opts);
      const hit = kept.get(key);
      if (hit && now() - hit.at < SEARCH_CACHE_SECS * 1000) return hit.result;
      const result = s.search(query, opts);
      kept.set(key, { at: now(), result });
      // Only a working answer is worth keeping.
      result.then(
        (r) => {
          if (r.status !== "ok") kept.delete(key);
        },
        () => kept.delete(key),
      );
      // Oldest first out, so a busy day doesn't grow it without end.
      while (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value!);
      return result;
    },
  }));
}

/**
 * How long a marketplace's answer is shared between every server instance, for
 * the price check (the extension and /check). Each product page a shopper with
 * the extension opens is a check, and each check an eBay search against the
 * site's 5,000 a day: a few hundred shoppers would use the day up by noon. A
 * hundred shoppers on the same AirPods page now cost one search per half hour.
 * The shopper's own price is never cached, only the market it is compared
 * with, and a price on eBay rarely moves in half an hour.
 */
export const SHARED_CACHE_SECS = 30 * 60;

/**
 * The same sources, a recent answer kept in the shared database for everyone.
 * Without a database (tests, local runs) they answer live. A database that
 * fails is skipped, never a reason for the check to fail.
 */
export function sharedSources(
  sources: MarketplaceSource[],
  kv: Kv | null = UpstashKv.fromEnv(),
  secs = SHARED_CACHE_SECS,
): MarketplaceSource[] {
  if (!kv) return sources;
  return sources.map((s) => ({
    ...s,
    id: s.id,
    priceComparable: s.priceComparable,
    search: async (query: string, opts: SearchOptions = {}) => {
      const key = `sigpath:market:${createHash("sha256").update(keyOf(s.id, query, opts)).digest("hex").slice(0, 32)}`;
      const hit = await kv.command<string | null>(["GET", key]).catch(() => null);
      if (hit) {
        try {
          const r = JSON.parse(hit) as SourceResult;
          if (r.status === "ok" && Array.isArray(r.listings)) return r;
        } catch {
          // not ours, or cut short: ask the marketplace
        }
      }
      const result = await s.search(query, opts);
      if (result.status === "ok") await kv.command(["SET", key, JSON.stringify(result), "EX", secs]).catch(() => null);
      return result;
    },
  }));
}

/** Tests only. */
export function clearSearchCache() {
  kept.clear();
}
