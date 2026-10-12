/**
 * lib/extension/seen.ts — Amazon prices seen by SigPath shoppers.
 *
 * WHY
 * Amazon's product API isn't open to SigPath yet (registry.ts), and SigPath
 * never sends a bot to Amazon. The SigPath browser extension (extension/)
 * reads the Amazon.de pages a shopper opens, in their own browser, and, with
 * the "share prices" switch on, sends the products and prices it saw here.
 * Over time that is SigPath's own record of Amazon prices, gathered from
 * people's shopping rather than by scraping.
 *
 * WHAT IS KEPT
 * Per product (its ASIN): the title, the price, a photo address and when it
 * was seen. Nothing about the shopper: no account, no address, no history of
 * who saw what. A newer sighting replaces the older one.
 *
 * WHAT IT IS, AND ISN'T
 * A price someone saw, not a live one, and anyone with the extension can send
 * one, so it is never trusted: the search shows it as "seen on Amazon", never
 * price-checked and never in the median, and its link is Amazon's own product
 * page (with the Associates tag), where the real price is. Sightings older than
 * a week are not shown.
 */

import { tableFromEnv, type Table } from "../kv/table";
import type { Listing, Money } from "../marketplace/types";
import { join } from "path";
import { dataDir } from "../data-dir";

export interface SeenItem {
  asin: string;
  title: string;
  price: Money;
  imageUrl?: string;
  /** When it was seen (ms). */
  seenAt: number;
}

export const SEEN_MAX_AGE_MS = 7 * 24 * 3600_000;
/** How many products one request may report: an Amazon results page has up to ~60. */
export const SEEN_MAX_ITEMS = 60;

const ASIN = /^[A-Z0-9]{10}$/;
const IMAGE_HOSTS = /^https:\/\/(m\.media-amazon\.com|images-[a-z]{2}\.ssl-images-amazon\.com|images-amazon\.com)\//;

/**
 * One reported product, cleaned, or null when anything about it is off. Only
 * euro prices (Amazon.de), only plausible ones, only Amazon's own image hosts.
 */
export function cleanSeen(raw: unknown, now: number): SeenItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const asin = typeof r.asin === "string" ? r.asin.trim().toUpperCase() : "";
  const title = typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const p = r.price as Record<string, unknown> | undefined;
  const amount = typeof p?.amount === "number" ? Math.round(p.amount) : NaN;
  if (!ASIN.test(asin) || title.length < 3) return null;
  if (p?.currency !== "EUR" || !Number.isFinite(amount) || amount < 50 || amount > 5_000_000) return null;
  const image = typeof r.imageUrl === "string" && IMAGE_HOSTS.test(r.imageUrl) ? r.imageUrl.slice(0, 500) : undefined;
  return { asin, title, price: { amount, currency: "EUR" }, imageUrl: image, seenAt: now };
}

export class SeenStore {
  constructor(private readonly table: Table<SeenItem>) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): SeenStore {
    return new SeenStore(
      tableFromEnv<SeenItem>(env, { explicitFile: env.AMAZON_SEEN_FILE, defaultFile: join(dataDir(env), "amazon-seen.json"), name: "amazon-seen" }),
    );
  }

  /** Keep what's well formed; returns how many were kept. */
  async record(items: unknown[], now = Date.now()): Promise<number> {
    const clean: Record<string, SeenItem> = {};
    for (const raw of items.slice(0, SEEN_MAX_ITEMS)) {
      const item = cleanSeen(raw, now);
      if (item) clean[item.asin] = item;
    }
    const n = Object.keys(clean).length;
    if (n) await this.table.setMany(clean);
    return n;
  }

  /** Sightings from the last week whose titles name every word of the search. */
  async search(query: string, now = Date.now(), limit = 20): Promise<SeenItem[]> {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return [];
    const all = Object.values(await this.table.all());
    return all
      .filter((s) => now - s.seenAt < SEEN_MAX_AGE_MS)
      .filter((s) => {
        const t = s.title.toLowerCase();
        return words.every((w) => t.includes(w));
      })
      .sort((a, b) => b.seenAt - a.seenAt)
      .slice(0, limit);
  }
}

/** A sighting as a search listing: Amazon's own product page, tagged when there's an Associates id. */
export function seenListing(s: SeenItem, tag: string | null): Listing {
  return {
    id: s.asin,
    source: "amazon",
    title: s.title,
    url: `https://www.amazon.de/dp/${s.asin}${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`,
    affiliate: !!tag,
    price: s.price,
    condition: "new",
    imageUrl: s.imageUrl,
    seller: { handle: "amazon.de" },
    seenAt: s.seenAt,
  };
}
