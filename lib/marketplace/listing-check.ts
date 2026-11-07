/**
 * lib/marketplace/listing-check.ts — SigPath's check on the eBay listing a
 * shopper has open (the extension on an eBay item page).
 *
 * This is where SigPath's verdicts come from in the first place: an eBay
 * listing, judged against the other listings of the same product. The page
 * gives only the item number; the listing itself (price, shipping, condition,
 * seller and ratings, photo, category) comes from eBay's own API, read exactly
 * as a search result is (sources/ebay.ts, ebayListing), never from the page.
 *
 * Then it is checked as the search page checks it: the product searched for by
 * its own title (shortQuery), the listing added to the results if eBay's search
 * didn't return it, every flag and the verdict drawn from the whole set. On top
 * of that, what a shopper on that page wants to know:
 *   - the deal score against the same product in its condition, without itself
 *   - the cheapest OTHER checked listing of the same product and condition,
 *     only when it is cheaper than this one
 */

import { searchAll } from "./search";
import { bestCheckedDeals, conditionGroup, withLabels, type LabelledListing } from "./label";
import { sameProduct } from "./identity";
import { dealTone } from "./market";
import { checkSources, ebayMarket, shortQuery, type Market } from "./price-check";
import { EbaySource, type ItemLookup } from "./sources/ebay";
import type { MarketplaceSource } from "./sources/types";
import { listingKey, totalPrice, type Listing, type Money } from "./types";
import { DecisionLog } from "../reports/reports";

type Env = Record<string, string | undefined>;

export interface ListingCheckDeps {
  lookup: (itemNumber: string) => Promise<ItemLookup>;
  sources: MarketplaceSource[];
  upheldReports?: () => Promise<ReadonlyMap<string, number>>;
}

export function listingCheckDeps(env: Env = process.env): ListingCheckDeps {
  const ebay = new EbaySource(env);
  return {
    lookup: (n) => ebay.listingByItemNumber(n),
    sources: checkSources(env),
    upheldReports: () => DecisionLog.fromEnv(env).upheldCounts(),
  };
}

export type ListingCheck =
  | { ok: false; status: Exclude<ItemLookup["status"], "ok">; detail: string }
  | {
      ok: true;
      query: string;
      /** The listing, as checked: its verdict, headline and points. */
      listing: LabelledListing;
      total: Money;
      comparison: { sampleSize: number; median: number } | null;
      market: Market | null;
      deal: { pct: number; tone: ReturnType<typeof dealTone> } | null;
      /** A cheaper checked listing of the same product and condition, if there is one. */
      cheaper: { listing: Listing; total: Money } | null;
      ebay: { status: string };
    };

export async function checkEbayListing(itemNumber: string, deps: ListingCheckDeps): Promise<ListingCheck> {
  const found = await deps.lookup(itemNumber);
  if (found.status !== "ok") return { ok: false, status: found.status, detail: found.detail };
  const page = found.listing;
  const query = shortQuery(page.title);

  // eBay's search may not return this listing (50 results, its own order): it is added, once.
  const sources = deps.sources.map(
    (s): MarketplaceSource =>
      s.id !== "ebay"
        ? s
        : {
            ...s,
            id: s.id,
            priceComparable: s.priceComparable,
            search: async (q, opts) => {
              const r = await s.search(q, opts);
              return r.status === "ok" && !r.listings.some((l) => l.id === page.id) ? { ...r, listings: [...r.listings, page] } : r;
            },
          },
  );
  const upheldReports = deps.upheldReports ? await deps.upheldReports() : undefined;
  const raw = await searchAll(query, sources, { limit: 50, currency: page.price.currency }, { upheldReports });
  const labelled = withLabels(raw);
  const key = listingKey(page);
  const listing = labelled.listings.find((l) => listingKey(l) === key);
  const ebayStatus = raw.sources.find((s) => s.source === "ebay")?.status ?? "error";
  if (!listing) return { ok: false, status: "error", detail: "eBay didn't answer the search for this product." };

  const comparison = raw.analysis.comparisons[key] ?? null;
  const mine = raw.analysis.identities[key];
  const same = (l: Listing) => {
    const theirs = raw.analysis.identities[listingKey(l)];
    return !!mine && !!theirs && theirs.named !== false && sameProduct(mine, theirs);
  };
  const total = totalPrice(listing);
  // Its own condition group: a used console against used ones, a new one against new ones, and a
  // refurbished one against new and refurbished together (against new alone it always looks a bargain).
  const group = conditionGroup(listing);
  const market = comparison ? ebayMarket(labelled.listings, raw.analysis, same, total.currency, group, key, listing.condition === "refurbished") : null;
  // Only for a price SigPath checked: a flagged "−60%" is bait, not a deal.
  const pct = listing.check.verdict === "checked" && market ? Math.round(((total.amount - market.typical) / market.typical) * 100) : null;
  const deal = pct === null ? null : { pct, tone: dealTone(pct) };

  const [best] = bestCheckedDeals(
    labelled.listings.filter((l) => l.source === "ebay" && listingKey(l) !== key && same(l) && conditionGroup(l) === group),
    (l) => (l as LabelledListing).check,
    raw.analysis,
  );
  const cheaper = best && best.total.currency === total.currency && best.total.amount < total.amount ? { listing: best.listing, total: best.total } : null;

  return { ok: true, query, listing, total, comparison, market, deal, cheaper, ebay: { status: ebayStatus } };
}
