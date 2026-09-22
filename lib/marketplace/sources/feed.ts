/**
 * lib/marketplace/sources/feed.ts — licensed affiliate product feeds.
 *
 * WHY THIS IS THE ANSWER TO "ADD MORE PLATFORMS"
 * Most retailers have no public search API. eBay and Amazon are the exceptions,
 * not the rule, so integrating marketplaces one at a time runs out of targets
 * almost immediately — which is the wall this project hit with idealo and
 * Kleinanzeigen.
 *
 * Affiliate networks exist to solve exactly that. Awin's publisher feed
 * database alone carries on the order of 200 million products across tens of
 * thousands of merchants, and the whole point of it is that publishers are
 * LICENSED to read and display that data. CJ and Tradedoubler work the same
 * way. So instead of one integration per retailer, this is one integration that
 * brings in as many merchants as the feed covers, with permission attached.
 *
 * It is also the only honest route for a retailer that has no API: a feed the
 * merchant published for this purpose is data we are meant to have, which a
 * scraped search results page is not.
 *
 * WHAT IT DOES NOT SOLVE
 * A feed is a catalogue, not a live search index. It is a periodic snapshot, so
 * prices lag reality by however often it is refreshed, and it covers the
 * merchants in that network rather than a whole marketplace. Both facts are
 * reported rather than hidden: `detail` carries the feed's age, and a stale
 * feed is surfaced so its prices are not silently treated as current.
 *
 * Kleinanzeigen in particular is NOT reachable this way. It is a classifieds
 * site for private sellers, not a merchant with an affiliate feed, so it stays
 * a link-out. Feeds add breadth for retail, not for classifieds.
 *
 * FORMAT
 * Deliberately generic: any delimited text feed with a header row. Awin's
 * Create-a-Feed CSV, a Google Shopping feed and a plain merchant export all
 * work, and the column names are configurable because no two networks agree on
 * them.
 */

import { readFile } from "fs/promises";
import type { Condition, Listing, SearchOptions, SourceResult } from "../types";
import type { MarketplaceSource } from "./types";

/**
 * Parse delimited text properly, including quoted fields.
 *
 * A split(",") would be shorter and wrong: product titles contain commas
 * constantly ("Lenovo ThinkPad X1 Carbon, 14 Zoll, 16GB"), and every row after
 * the first such title would have its columns shifted by one. That corrupts
 * prices silently, which then corrupts the median for every other source.
 */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      // Skip blank lines rather than emitting empty rows.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "1.234,56" / "1,234.56" / "19.99 EUR" -> 1999-style minor units. */
export function feedPriceToMinorUnits(raw: string): number | null {
  const s = raw.trim().replace(/[^\d.,]/g, "");
  if (!s) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalised: string;

  if (lastComma === -1 && lastDot === -1) {
    normalised = s;
  } else if (lastComma > lastDot) {
    // German style: dots group thousands, comma is the decimal separator.
    normalised = s.replace(/\./g, "").replace(",", ".");
  } else {
    normalised = s.replace(/,/g, "");
  }

  const n = Number(normalised);
  if (!Number.isFinite(n)) return null;
  // Round rather than truncate: 19.999 is a rounding artefact in a feed, not a
  // price of 19.99.
  return Math.round(n * 100);
}

function mapCondition(raw?: string): Condition {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("refurb")) return "refurbished";
  if (s === "new" || s.includes("neu")) return "new";
  if (s.includes("used") || s.includes("gebraucht")) return "used";
  return "unknown";
}

export interface FeedConfig {
  /** http(s) URL or a local path. */
  source: string;
  delimiter: string;
  /** Shown to the buyer, e.g. "Awin merchants". */
  label: string;
  currency: string;
  /** Column names, because no two networks agree on them. */
  columns: {
    id: string[];
    title: string[];
    url: string[];
    price: string[];
    currency: string[];
    merchant: string[];
    image: string[];
    condition: string[];
  };
  /** Cap on rows parsed. A full network feed is far too large to hold. */
  maxRows: number;
  /** How long a loaded feed is reused before being re-read. */
  cacheMs: number;
  /** Older than this and the feed is reported as stale. */
  staleMs: number;
}

const DEFAULT_COLUMNS: FeedConfig["columns"] = {
  id: ["aw_product_id", "product_id", "id", "sku"],
  title: ["product_name", "title", "name"],
  url: ["aw_deep_link", "merchant_deep_link", "link", "url"],
  price: ["search_price", "display_price", "price", "sale_price"],
  currency: ["currency", "curr"],
  merchant: ["merchant_name", "brand_name", "store", "brand"],
  image: ["merchant_image_url", "aw_image_url", "image_link", "image_url"],
  condition: ["condition", "product_condition"],
};

export function feedConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): FeedConfig | null {
  const source = env.FEED_URL?.trim();
  if (!source) return null;
  return {
    source,
    delimiter: env.FEED_DELIMITER || ",",
    label: env.FEED_LABEL?.trim() || "Affiliate feed",
    currency: (env.FEED_CURRENCY || "EUR").toUpperCase(),
    columns: DEFAULT_COLUMNS,
    maxRows: Number(env.FEED_MAX_ROWS ?? 50_000),
    cacheMs: Number(env.FEED_CACHE_MS ?? 15 * 60_000),
    staleMs: Number(env.FEED_STALE_MS ?? 48 * 3600_000),
  };
}

/** First header present in `names`, or -1. Header matching is case-insensitive. */
function columnIndex(header: string[], names: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
}

interface LoadedFeed {
  listings: Listing[];
  loadedAt: number;
}

export class FeedSource implements MarketplaceSource {
  readonly id = "feed" as const;

  private cache: LoadedFeed | null = null;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async load(cfg: FeedConfig): Promise<LoadedFeed> {
    if (this.cache && Date.now() - this.cache.loadedAt < cfg.cacheMs) return this.cache;

    const text = /^https?:\/\//i.test(cfg.source)
      ? await (async () => {
          const res = await this.fetchImpl(cfg.source, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new Error(`feed fetch returned ${res.status}`);
          return res.text();
        })()
      : await readFile(cfg.source, "utf8");

    const rows = parseDelimited(text, cfg.delimiter);
    if (!rows.length) throw new Error("feed is empty");

    const header = rows[0];
    const idx = {
      id: columnIndex(header, cfg.columns.id),
      title: columnIndex(header, cfg.columns.title),
      url: columnIndex(header, cfg.columns.url),
      price: columnIndex(header, cfg.columns.price),
      currency: columnIndex(header, cfg.columns.currency),
      merchant: columnIndex(header, cfg.columns.merchant),
      image: columnIndex(header, cfg.columns.image),
      condition: columnIndex(header, cfg.columns.condition),
    };

    // Without these four there is nothing usable. Failing loudly here beats
    // returning an empty feed that looks like "no matches".
    const required: (keyof typeof idx)[] = ["title", "url", "price"];
    const missing = required.filter((k) => idx[k] === -1);
    if (missing.length) {
      throw new Error(
        `feed is missing required column(s): ${missing.join(", ")}. ` +
          `Header was: ${header.slice(0, 12).join(", ")}`,
      );
    }

    const listings: Listing[] = [];
    for (let r = 1; r < rows.length && listings.length < cfg.maxRows; r++) {
      const row = rows[r];
      const amount = feedPriceToMinorUnits(row[idx.price] ?? "");
      const url = row[idx.url]?.trim();
      const title = row[idx.title]?.trim();
      // A row we cannot price is dropped, not guessed at — a wrong price here
      // becomes a wrong median for every other source in the comparison.
      if (amount === null || !url || !title) continue;

      const merchant = (idx.merchant !== -1 ? row[idx.merchant]?.trim() : "") || "unknown merchant";

      listings.push({
        id: (idx.id !== -1 ? row[idx.id]?.trim() : "") || `${r}`,
        source: this.id,
        title,
        url,
        price: {
          amount,
          currency: ((idx.currency !== -1 ? row[idx.currency]?.trim() : "") || cfg.currency).toUpperCase(),
        },
        condition: mapCondition(idx.condition !== -1 ? row[idx.condition] : undefined),
        imageUrl: idx.image !== -1 ? row[idx.image]?.trim() || undefined : undefined,
        seller: { handle: merchant, displayName: merchant },
      });
    }

    this.cache = { listings, loadedAt: Date.now() };
    return this.cache;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SourceResult> {
    const cfg = feedConfigFromEnv(this.env);
    if (!cfg) {
      return {
        source: this.id,
        status: "not_configured",
        listings: [],
        detail: "FEED_URL is not set. Point it at a licensed affiliate product feed.",
      };
    }

    try {
      const feed = await this.load(cfg);

      // Every term must appear somewhere in the title. Crude, but a feed is a
      // flat catalogue with no relevance ranking of its own, and an OR match
      // would flood the results with anything sharing one common word — which
      // would then drag the median.
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = feed.listings
        .filter((l) => {
          const t = l.title.toLowerCase();
          return terms.every((term) => t.includes(term));
        })
        .slice(0, opts.limit ?? 20);

      const ageMs = Date.now() - feed.loadedAt;
      const stale = ageMs > cfg.staleMs;

      return {
        source: this.id,
        status: "ok",
        listings: matches,
        // A feed is a periodic snapshot, not a live index. Saying how old it is
        // keeps its prices from being read as current when they are not.
        detail: stale
          ? `${cfg.label} — feed snapshot is ${Math.round(ageMs / 3600_000)}h old and may be out of date.`
          : `${cfg.label} — catalogue snapshot, not a live price.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        source: this.id,
        status: /timeout|abort/i.test(msg) ? "timeout" : "error",
        listings: [],
        detail: msg.slice(0, 400),
      };
    }
  }
}
