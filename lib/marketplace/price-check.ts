/**
 * lib/marketplace/price-check.ts — check a price from any shop against the
 * live eBay market.
 *
 * The shopper brings the product: its title and price, read from the page they
 * are already looking at (the "SigPath check" bookmark on /check) or typed in.
 * Nothing is fetched from that shop: no API key, no scraping, no sign-up. The
 * product then goes through exactly the search's own comparison, as one more
 * listing next to live eBay results, so it gets the same verdict an eBay
 * listing would: compared only with listings of the same model, configuration
 * and condition, and flagged if it's far below them.
 */

import { searchAll } from "./search";
import { defaultSources } from "./sources";
import type { MarketplaceSource } from "./sources/types";
import { withLabels } from "./label";
import { listingKey, type Listing, type MarketplaceId, type Money } from "./types";
import { DecisionLog } from "../reports/reports";

const SYMBOLS: [RegExp, string][] = [
  [/€|\bEUR\b/i, "EUR"],
  [/£|\bGBP\b/i, "GBP"],
  [/\bRM\b|\bMYR\b/i, "MYR"],
  [/\bUSD\b|US\s?\$|\$/i, "USD"],
];

/**
 * "1.249,00 €", "€1,249.00", "EUR 23,50", "US $23.50", "RM 99", "23.5" ->
 * minor units and currency. A final "." or "," followed by one or two digits
 * is the decimal point; every other separator is a thousands separator.
 */
export function parsePrice(text: string, fallbackCurrency = "EUR"): Money | null {
  const t = text.trim();
  const currency = SYMBOLS.find(([re]) => re.test(t))?.[1] ?? fallbackCurrency;
  const num = t.match(/\d[\d.,\s]*/)?.[0].replace(/\s/g, "");
  if (!num) return null;
  const dec = num.match(/[.,](\d{1,2})$/);
  const whole = (dec ? num.slice(0, -dec[0].length) : num).replace(/[.,]/g, "");
  const amount = Number(whole) * 100 + (dec ? Number(dec[1].padEnd(2, "0")) : 0);
  return Number.isFinite(amount) && amount > 0 ? { amount, currency } : null;
}

/** Words that describe a product rather than name it: a shop title's model name ends before them. */
const GENERIC = new Set([
  "wireless", "bluetooth", "kabellos", "kabellose", "kabelloser", "in-ear", "earbuds", "earphones", "headphones", "headset",
  "kopfhörer", "ohrhörer", "smartphone", "handy", "laptop", "notebook", "tablet", "console", "konsole", "gaming",
  "with", "mit", "for", "für", "and", "und", "inkl", "inkl.", "including", "new", "neu", "original", "genuine",
]);

/**
 * A shop's title -> an eBay search. Shop titles run long ("Apple AirPods Pro 2
 * Wireless Earbuds, Up to 2x More..."), and SigPath only compares listings
 * whose titles name every searched word, so the search must be just the model:
 * the name before the first comma, bracket or dash, cut at the first word that
 * describes rather than names (never the first two), at most six words.
 */
export function shortQuery(title: string): string {
  const head = title.replace(/[®™©]/g, " ").split(/,|\(|\[|\s[-–—|]\s/)[0];
  const words = head.trim().split(/\s+/).filter(Boolean);
  const cut = words.findIndex((w, i) => i >= 2 && GENERIC.has(w.toLowerCase()));
  return (cut >= 0 ? words.slice(0, cut) : words).slice(0, 6).join(" ");
}

export const SHOPS: Record<string, { source: MarketplaceId; label: string }> = {
  amazon: { source: "amazon", label: "Amazon" },
  aliexpress: { source: "aliexpress", label: "AliExpress" },
  other: { source: "feed", label: "another shop" },
};

export interface PriceCheckInput {
  title: string;
  price: Money;
  from: keyof typeof SHOPS;
  url?: string;
}

export async function checkPrice(
  input: PriceCheckInput,
  env: Record<string, string | undefined> = process.env,
  ebay: MarketplaceSource[] = defaultSources(env).filter((s) => s.id === "ebay"),
) {
  const shop = SHOPS[input.from] ?? SHOPS.other;
  const query = shortQuery(input.title);
  const product: Listing = {
    id: "checked-price",
    source: shop.source,
    title: input.title,
    url: input.url ?? "",
    price: input.price,
    condition: "new",
    seller: { handle: "the shop" },
  };
  // The product as a source of its own, compared like any other listing.
  const brought: MarketplaceSource = {
    id: shop.source,
    priceComparable: true,
    search: async () => ({ source: shop.source, status: "ok", listings: [product] }),
  };
  const upheldReports = await DecisionLog.fromEnv(env).upheldCounts();
  const raw = await searchAll(query, [...ebay, brought], { limit: 50, currency: input.price.currency }, { upheldReports });
  const labelled = withLabels(raw);
  const key = listingKey(product);
  const ebayStatus = raw.sources.find((s) => s.source === "ebay");
  return {
    query,
    shop: shop.label,
    product: labelled.listings.find((l) => listingKey(l) === key)!,
    comparison: raw.analysis.comparisons[key] ?? null,
    ebay: { status: ebayStatus?.status ?? "error", count: ebayStatus?.count ?? 0 },
    bestEbay: labelled.bestCheckedDeals
      .filter((d) => d.listing.startsWith("ebay:"))
      .map((d) => ({ ...d, listing: labelled.listings.find((l) => listingKey(l) === d.listing)! })),
  };
}
