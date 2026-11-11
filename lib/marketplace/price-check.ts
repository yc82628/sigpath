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

import { searchAll, type SearchResponse } from "./search";
import { defaultSources } from "./sources";
import type { MarketplaceSource } from "./sources/types";
import { bestCheckedDeals, withLabels, type LabelPoint } from "./label";
import { listingKey, totalPrice, type Listing, type MarketplaceId, type Money } from "./types";
import { sameProduct, VARIANT_WORDS } from "./identity";
import { dealTone, quantile } from "./market";
import { median, MIN_SAMPLE } from "./anomaly";
import { cachedSources, sharedSources } from "./search-cache";
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
  "kopfhörer", "kopfhorer", "kopfhoerer", "ohrhörer", "ohrhorer", "smartphone", "handy", "laptop", "notebook", "tablet", "console", "konsole", "gaming",
  "with", "mit", "for", "für", "and", "und", "inkl", "inkl.", "including", "new", "neu", "original", "genuine",
  // Marketing words shops put before the features: "Sony WF-1000XM5 Premium True Wireless…" searched eBay
  // for "Sony WF-1000XM5 Premium True", which almost no listing says, and wasn't compared at all.
  "premium", "true", "truly", "noise", "cancelling", "canceling", "active", "aktive", "aktiver", "geräuschunterdrückung",
  // eBay titles add the condition and the colour: "Nintendo Switch OLED-Modell 64GB weiß Sehr Gut" searched
  // for "… weiß Sehr" and found almost nothing to compare with. The condition comes from eBay's own field.
  "sehr", "gut", "top", "zustand", "ovp", "wie", "neuwertig", "gebraucht", "refurbished", "generalüberholt", "used",
  "weiß", "weiss", "white", "schwarz", "black", "blau", "blue", "rot", "red", "grau", "grey", "gray", "silber", "silver",
  "grün", "green", "rosa", "pink", "gold", "lila", "purple", "gelb", "yellow",
]);

/** "64GB", "1TB", "128 GB": the storage, read from every title by identity.ts, so not needed in the search. */
const STORAGE = /^\d+(?:[.,]\d+)?(gb|tb)$/i;

/** Words after a dash or in brackets that change which model it is: "Nintendo Switch – OLED-Modell". */
const QUALIFIERS = new Set([...VARIANT_WORDS, "digital"]);

/**
 * A shop's title -> an eBay search. Shop titles run long ("Apple AirPods Pro 2
 * Wireless Earbuds, Up to 2x More..."), and SigPath only compares listings
 * whose titles name every searched word, so the search must be just the model:
 * the name before the first comma, bracket or dash, cut at the first word that
 * describes rather than names (never the first two), at most six words.
 *
 * Shops put model words after a dash or in brackets too: "Nintendo Switch –
 * OLED-Modell", "PlayStation 5 Konsole – Digital Edition (Slim)". Searched
 * without them, an OLED was priced against the cheaper plain Switch. So the
 * first such word (VARIANT_WORDS, or "digital") joins the search, from the
 * part before the first comma only. One word, not all: eBay titles name a
 * "PlayStation 5 Digital Edition Slim" in any order, and a longer search
 * names fewer of them.
 */
export function shortQuery(title: string, opts: { keepStorage?: boolean } = {}): string {
  const clean = title.replace(/[®™©]/g, " ");
  const [first, ...rest] = clean.split(",")[0].split(/\(|\)|\[|\]|\s[-–—|]\s/);
  // A storage size isn't searched for: listings that don't spell it out are still the same product, and
  // identity.ts compares only listings whose storage doesn't conflict.
  const words = first.trim().replace(/(\d)\s+(gb|tb)\b/gi, "$1$2").split(/\s+/).filter((w) => w && (opts.keepStorage || !STORAGE.test(w)));
  const cut = words.findIndex((w, i) => i >= 2 && GENERIC.has(w.toLowerCase()));
  const base = (cut >= 0 ? words.slice(0, cut) : words).slice(0, 6);
  const has = new Set(base.flatMap((w) => w.toLowerCase().split("-")));
  const extra = rest
    .flatMap((seg) => seg.split(/[\s-]+/))
    .filter((w) => QUALIFIERS.has(w.toLowerCase()) && !has.has(w.toLowerCase()) && (has.add(w.toLowerCase()), true));
  return [...base, ...extra.slice(0, 1)].slice(0, 6).join(" ");
}

/** What a product is, said in passing in a shop's title ("PlayStation 5 Konsole – Digital Edition"). */
const CATEGORY_NOUNS =
  /(^|\s)(konsole|console|spielkonsole|smartphone|handy|laptop|notebook|tablet|kopfhörer|kopfhorer|kopfhoerer|ohrhörer|ohrhorer|headphones|earbuds|earphones|headset)(?=\s|$)/gi;

export const SHOPS: Record<string, { source: MarketplaceId; label: string }> = {
  amazon: { source: "amazon", label: "Amazon" },
  aliexpress: { source: "aliexpress", label: "AliExpress" },
  // German shops the extension reads (extension/): checked like any other shop.
  otto: { source: "feed", label: "OTTO" },
  mediamarkt: { source: "feed", label: "MediaMarkt" },
  saturn: { source: "feed", label: "Saturn" },
  other: { source: "feed", label: "another shop" },
};

export type MarketBasis = "new" | "new-refurbished" | "used";
export interface Market {
  /** In minor units: the usual range, the typical (median) price, and how many listings they come from. */
  low: number;
  high: number;
  typical: number;
  count: number;
  currency: string;
  basis: MarketBasis;
}

/**
 * The eBay market a price is measured against: the listings of the same
 * product it was compared with, in one condition. For new, NEW ones only when
 * there are enough of them. The scam check pools refurbished with new
 * (anomaly.ts), which is right for "far too cheap" but not for a deal score:
 * an iPhone 15 at 699 € read "+53%" against eight refurbished phones. With too
 * few new ones the pool is used, and says so (basis "new-refurbished").
 * `exclude` leaves out the listing being judged, when it is on eBay itself;
 * `pooled` asks for new and refurbished together whatever the counts, for a
 * refurbished listing, which against new prices alone always looks a bargain.
 */
export function ebayMarket(
  listings: Listing[],
  analysis: SearchResponse["analysis"],
  same: (l: Listing) => boolean,
  currency: string,
  group: "new" | "used",
  exclude?: string,
  pooled = false,
): Market | null {
  const pool = listings.filter(
    (l) =>
      l.source === "ebay" &&
      (group === "used" ? l.condition === "used" : l.condition !== "used") &&
      analysis.comparisons[listingKey(l)] &&
      same(l) &&
      totalPrice(l).currency === currency &&
      listingKey(l) !== exclude,
  );
  const fresh = pool.filter((l) => l.condition === "new");
  const basis: MarketBasis = group === "used" ? "used" : !pooled && fresh.length >= MIN_SAMPLE ? "new" : "new-refurbished";
  const totals = (basis === "new" ? fresh : pool).map((l) => totalPrice(l).amount).sort((a, b) => a - b);
  if (totals.length < MIN_SAMPLE) return null;
  // The usual range: the middle 80% of ten or more prices, the middle half of fewer, where one
  // odd listing would otherwise be the whole bottom of the range.
  const [lo, hi] = totals.length >= 10 ? [0.1, 0.9] : [0.25, 0.75];
  return { low: quantile(totals, lo), high: quantile(totals, hi), count: totals.length, typical: median(totals), currency, basis };
}

export interface PriceCheckInput {
  title: string;
  price: Money;
  from: keyof typeof SHOPS;
  url?: string;
}

/**
 * What a price is checked against: eBay (the market) and AliExpress (shown as
 * an alternative, never in the market price), each answer shared between
 * shoppers for half an hour (search-cache.ts).
 */
export function checkSources(env: Record<string, string | undefined> = process.env): MarketplaceSource[] {
  return cachedSources(sharedSources(defaultSources(env).filter((s) => s.id === "ebay" || s.id === "aliexpress")));
}

/**
 * An AliExpress offer is shown next to a check only at 75% of the market price
 * or more. Below that, for a branded product, it is far more often a copy than
 * a bargain, and AliExpress prices are never checked (sources/aliexpress.ts):
 * the panel must not send a shopper from a fair price to a fake.
 */
export const ALTERNATIVE_MIN_RATIO = 0.75;

/**
 * A shop's price comes without a seller SigPath could look up: "no upheld
 * reports against this seller" would vouch for nobody in particular.
 */
const SHOP_REPORTS: LabelPoint = { tone: "info", about: "reports", text: "Buyer reports not checked: the shop's page doesn't say who the seller is." };

export async function checkPrice(
  input: PriceCheckInput,
  env: Record<string, string | undefined> = process.env,
  sources: MarketplaceSource[] = checkSources(env),
) {
  const shop = SHOPS[input.from] ?? SHOPS.other;
  const query = shortQuery(input.title);
  const product: Listing = {
    id: "checked-price",
    source: shop.source,
    // Compared without the category nouns shops add, so "PlayStation 5 Konsole – Digital Edition"
    // still names the "PlayStation 5 Digital" it is searched as. Shown with its own title.
    title: input.title.replace(CATEGORY_NOUNS, "$1").replace(/\s+/g, " ").trim(),
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
  const raw = await searchAll(query, [...sources, brought], { limit: 50, currency: input.price.currency }, { upheldReports });
  const labelled = withLabels(raw);
  const key = listingKey(product);
  const ebayStatus = raw.sources.find((s) => s.source === "ebay");
  const comparison = raw.analysis.comparisons[key] ?? null;
  const mine = raw.analysis.identities[key];
  const same = (l: Listing) => {
    const theirs = raw.analysis.identities[listingKey(l)];
    return !!mine && !!theirs && theirs.named !== false && sameProduct(mine, theirs);
  };
  const currency = input.price.currency;

  const market = comparison ? ebayMarket(labelled.listings, raw.analysis, same, currency, "new") : null;

  // Only for a price SigPath checked, as on the search page: a flagged price 60% under the market is no deal.
  const checked = labelled.listings.find((l) => listingKey(l) === key)!;
  const pct =
    checked.check.verdict === "checked" && market ? Math.round(((totalPrice(product).amount - market.typical) / market.typical) * 100) : null;
  const deal = pct === null ? null : { pct, tone: dealTone(pct) };

  // The cheapest AliExpress offer for the same product, new, at a believable price. Not when the
  // product being checked is already on AliExpress: that's the page the shopper is on.
  const elsewhere =
    comparison && shop.source !== "aliexpress"
      ? labelled.listings
          .filter((l) => l.source === "aliexpress" && l.condition !== "used" && same(l))
          .map((l) => ({ listing: l, total: totalPrice(l) }))
          // Cheaper than the page the shopper is on, but not so cheap it's more likely a copy.
          .filter((x) => x.total.currency === currency && x.total.amount < input.price.amount)
          .filter((x) => x.total.amount >= (market?.typical ?? comparison.median) * ALTERNATIVE_MIN_RATIO)
          .sort((a, b) => a.total.amount - b.total.amount)[0] ?? null
      : null;

  return {
    query,
    shop: shop.label,
    product: {
      ...checked,
      title: input.title,
      check: { ...checked.check, points: checked.check.points.map((p) => (p.about === "reports" ? SHOP_REPORTS : p)) },
    },
    comparison,
    market,
    deal,
    elsewhere,
    ebay: { status: ebayStatus?.status ?? "error", count: ebayStatus?.count ?? 0 },
    // The cheapest checked eBay deal per condition on the same product as the one checked: same
    // model, variant, generation and size. Taken from the whole search, a Kindle Paperwhite check
    // offered a 5th-generation one and a 256 GB phone a 512 GB one.
    bestEbay: bestCheckedDeals(
      labelled.listings.filter((l) => l.source === "ebay" && same(l)),
      (l) => (l as (typeof labelled.listings)[number]).check,
      raw.analysis,
    ).map((d) => ({ ...d, listing: d.listing as (typeof labelled.listings)[number], belowMedian: d.belowMedian ?? null })),
  };
}
