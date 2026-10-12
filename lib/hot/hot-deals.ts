/**
 * lib/hot/hot-deals.ts — the home page's "Selling fast on AliExpress".
 *
 * WHAT
 * The products AliExpress itself reports selling most, with its count of orders
 * in the last 30 days (sources/aliexpress.ts, hotProducts). Something new, that
 * other buyers are actually ordering, rather than SigPath's own fixed searches.
 * Each one links to SigPath's price check, so a shopper sees it compared with
 * eBay before buying.
 *
 * WHY NOT EBAY
 * eBay's public API says nothing about what sells: no sales counts, no best
 * sellers. Anything SigPath showed as "hot" on eBay would be a guess. So the
 * section waits for a marketplace that publishes the numbers: AliExpress now,
 * Amazon if its API is ever open to SigPath. Without the AliExpress keys there
 * is no section, and the home page shows its popular searches.
 *
 * COST
 * One request to AliExpress an hour for the whole site: the answer is kept in
 * the shared database (or this instance's memory without one). An empty answer
 * is kept five minutes only, so the section comes back soon after an outage.
 */

import type { Kv } from "../kv/upstash";
import { UpstashKv } from "../kv/upstash";
import type { HotProduct } from "../marketplace/sources/aliexpress";

export type { HotProduct };

export interface HotDeals {
  deals: HotProduct[];
  /** When they were fetched (ms). */
  at: number;
}

export const HOT_TTL_SECONDS = 3600;
const EMPTY_TTL_SECONDS = 300;
const KEY = "sigpath:hot-products:v1";

let memory: HotDeals | null = null;

/** The hot products, from the cache when it's fresh, else fetched again and kept. */
export async function hotDeals(opts: {
  fetch: () => Promise<HotProduct[]>;
  max?: number;
  kv?: Kv | null;
  now?: () => number;
}): Promise<HotDeals> {
  const now = (opts.now ?? Date.now)();
  const kv = opts.kv === undefined ? UpstashKv.fromEnv() : opts.kv;
  const fresh = (h: HotDeals | null) =>
    h && now - h.at < (h.deals.length ? HOT_TTL_SECONDS : EMPTY_TTL_SECONDS) * 1000 ? h : null;

  if (fresh(memory)) return memory!;
  if (kv) {
    try {
      const raw = await kv.command<string | null>(["GET", KEY]);
      const kept = fresh(raw ? (JSON.parse(raw) as HotDeals) : null);
      if (kept) return (memory = kept);
    } catch {
      // The database not answering is no reason to show nothing: fetch them here.
    }
  }

  const deals = await opts.fetch().catch(() => [] as HotProduct[]);
  const found: HotDeals = { deals: deals.slice(0, opts.max ?? 4), at: now };
  memory = found;
  if (kv) {
    const ttl = found.deals.length ? HOT_TTL_SECONDS : EMPTY_TTL_SECONDS;
    await kv.command(["SET", KEY, JSON.stringify(found), "EX", ttl]).catch(() => undefined);
  }
  return found;
}

/** Tests only: forget the in-memory copy. */
export function resetHotDealsMemory() {
  memory = null;
}
