/**
 * lib/marketplace/link-query.ts — a product link pasted into the search.
 *
 * A shop's product link usually carries the product's name in its path
 * (amazon.de/Apple-AirPods-Pro-2-Generation/dp/B0CHWRXH8B, otto.de/p/apple-
 * iphone-15-...-1234567/). SigPath reads the name from the link itself and
 * searches for it. The shop's page is never fetched: nothing is sent to the
 * shop, so this is not scraping. A link with no name in it (AliExpress's
 * /item/1005006.html) can't be read, and the search page says so.
 */

import { shortQuery } from "./price-check";

export interface LinkQuery {
  query: string;
  /** Which shop the link is from, for the search page's note. */
  shop: string;
  /** Amazon's product number, when the link has one. */
  asin?: string;
}

const SHOP_NAMES: [RegExp, string][] = [
  [/(^|\.)amazon\.[a-z.]+$/, "Amazon"],
  [/(^|\.)otto\.de$/, "OTTO"],
  [/(^|\.)mediamarkt\.[a-z.]+$/, "MediaMarkt"],
  [/(^|\.)saturn\.de$/, "Saturn"],
  [/(^|\.)aliexpress\.[a-z.]+$/, "AliExpress"],
  [/(^|\.)ebay\.[a-z.]+$/, "eBay"],
];

export const looksLikeLink = (q: string) => /^(https?:\/\/|www\.)\S+$/i.test(q.trim());

/** The words of a path segment: "Apple-AirPods-Pro-2-Generation" -> "Apple AirPods Pro 2 Generation". */
function words(segment: string): string[] {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // a broken escape: use it as it is
  }
  return s
    .replace(/\.(html?|aspx?|php)$/i, "")
    .replace(/^_+/, "")
    .split(/[-_+\s]+/)
    // Not words: long numbers (shop ids) and product codes like an ASIN (B0CHWRXH8B).
    .filter((w) => w && w.length <= 40 && !/^\d{5,}$/.test(w) && !(/^[A-Z0-9]{10}$/.test(w) && /\d/.test(w)));
}

/** The product name in a shop link, or null when the link carries none. */
export function queryFromLink(raw: string): LinkQuery | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const shop = SHOP_NAMES.find(([re]) => re.test(host))?.[1] ?? host.replace(/^www\./, "");
  // "ref=sr_1_1" and the like are tracking, not names.
  const segments = url.pathname.split("/").filter((s) => s && !s.includes("="));

  // Amazon: the name is the segment before /dp/ (or /gp/product/); the ASIN after it.
  const dp = shop === "Amazon" ? segments.findIndex((s, i) => s === "dp" || (s === "product" && segments[i - 1] === "gp")) : -1;
  const asin = dp >= 0 && /^[A-Z0-9]{10}$/i.test(segments[dp + 1] ?? "") ? segments[dp + 1].toUpperCase() : undefined;
  const nameAt = dp - (segments[dp] === "product" ? 2 : 1);
  const candidates = dp >= 0 ? (nameAt >= 0 ? [segments[nameAt]] : []) : segments;

  // Otherwise the longest segment that reads as words (most shops: one slug per product).
  const best = candidates
    .map(words)
    .filter((w) => w.length >= 2 && w.some((x) => /[a-zäöüß]/i.test(x)))
    .sort((a, b) => b.length - a.length)[0];
  if (!best) return null;
  const query = shortQuery(best.join(" ")) || best.slice(0, 6).join(" ");
  return query.length >= 3 ? { query, shop, asin } : null;
}
