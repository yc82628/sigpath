/**
 * lib/marketplace/search.ts — fan out, merge, analyse.
 *
 * THE ONE RULE
 * Every source that was ASKED appears in the result, including the ones that
 * failed. Nothing is filtered out for being empty or broken. Downstream, the
 * anomaly check reads those failures and withholds its price verdict rather
 * than comparing against a biased sample — which only works if the failures
 * survive this far.
 */

import type { Listing, SearchOptions, SourceResult } from "./types";
import { listingKey, sellerKey, totalPrice } from "./types";
import type { MarketplaceSource } from "./sources/types";
import { analyse, type Analysis, type Flag } from "./anomaly";
import { linkOutTargets, type LinkOut } from "./registry";
import { usedFromTitle } from "./identity";

export interface SearchResponse {
  query: string;
  listings: Listing[];
  /** One entry per source asked, ok or not. */
  sources: { source: string; status: string; count: number; detail?: string }[];
  analysis: Analysis;
  /**
   * Marketplaces we cover but may not query, with a deep link into their own
   * search. See registry.ts — for idealo and Kleinanzeigen there is no API we
   * are permitted to use, so the buyer gets one click instead of nothing.
   *
   * These contribute no listings and therefore no prices, which is why they are
   * a separate field rather than a fake source: nothing here may ever reach the
   * median.
   */
  linkOut: LinkOut[];
}

/** Cheapest first, by what the buyer actually pays. */
function byTotalAscending(a: Listing, b: Listing): number {
  return totalPrice(a).amount - totalPrice(b).amount;
}

/**
 * The condition the title states, when it says used and the listing says new
 * (or nothing). Refurbished stays refurbished: "Wie neu" and "Sehr gut" are
 * how refurbishers grade their stock.
 */
function readCondition(l: Listing): Listing {
  if (l.condition === "used" || l.condition === "refurbished") return l;
  const phrase = usedFromTitle(l.title);
  return phrase ? { ...l, condition: "used", conditionFromTitle: phrase } : l;
}

/**
 * What the shopper came for comes first. A search for "AirPods Pro" sorted by
 * price alone opens with charging cases and broken units, the cheapest things
 * that mention the name. So: the product itself, then listings whose title
 * doesn't name the searched model, then accessories, then items sold for
 * parts; cheapest first within each. Nothing is hidden, only moved down.
 */
export function shopperOrder(listings: Listing[], identities: Analysis["identities"]): Listing[] {
  const rank = (l: Listing) => {
    const id = identities[listingKey(l)];
    if (!id) return 1;
    if (id.kind === "parts") return 3;
    if (id.kind === "accessory") return 2;
    return id.named === false ? 1 : 0;
  };
  return [...listings].sort((a, b) => rank(a) - rank(b) || byTotalAscending(a, b));
}

/**
 * Flag every listing from a seller with upheld fake-product reports.
 *
 * This is the penalty buyers see. It rests only on reports a reviewer UPHELD —
 * filed by a verified buyer, with live evidence — never on pending ones, and
 * the wording says exactly that. A flag also removes the listing's pay button,
 * so the same finding keeps SigPath's own money away from the seller.
 */
export function upheldReportFlags(listings: Listing[], upheld: ReadonlyMap<string, number>): Flag[] {
  const flags: Flag[] = [];
  for (const l of listings) {
    const n = upheld.get(sellerKey(l.source, l.seller.handle)) ?? 0;
    if (n > 0) {
      flags.push({
        source: l.source,
        listingId: l.id,
        kind: "upheld_reports",
        message:
          n === 1
            ? "A verified buyer's fake-product report against this seller was upheld after review."
            : `${n} verified buyers' fake-product reports against this seller were upheld after review.`,
      });
    }
  }
  return flags;
}

/**
 * Start every source now, and return one promise per source, in source order.
 * Each promise always RESOLVES — to the source's result, or to a typed error if
 * a non-conforming source rejected — so the caller can show each marketplace
 * the moment it answers (the search page streams them) and still assemble the
 * full result from the very same requests: nothing is ever queried twice.
 */
export function startSearch(query: string, sources: MarketplaceSource[], opts: SearchOptions = {}): Promise<SourceResult>[] {
  const q = query.trim();
  return sources.map((s) => {
    // Comparability comes from the SOURCE, not the outcome, and is attached on
    // both paths: the analysis needs to know whether a source that failed was
    // one whose absence biases the median, and a thrown error carries nothing.
    const comparable = s.priceComparable !== false;
    // A conforming source never rejects (see sources/types.ts), but a
    // third-party one added later might, and that must degrade to a typed
    // failure rather than taking the whole search down.
    return s.search(q, opts).then(
      (r) => ({ ...r, comparable }),
      (reason: unknown) => ({
        source: s.id,
        status: "error" as const,
        listings: [],
        comparable,
        detail: reason instanceof Error ? `source threw: ${reason.message.slice(0, 160)}` : "source threw a non-Error",
      }),
    );
  });
}

/** The full response from every source's result. Runs only once ALL have answered. */
export function assembleSearch(
  query: string,
  results: SourceResult[],
  opts: SearchOptions = {},
  context: { upheldReports?: ReadonlyMap<string, number> } = {},
): SearchResponse {
  const q = query.trim();
  // A listing sold as new whose title says it's used ("Zustand gut") is compared with used ones.
  results = results.map((r) => ({ ...r, listings: r.listings.map(readCondition) }));
  const listings = results.flatMap((r) => r.listings).sort(byTotalAscending);
  // A snapshot source with nothing to show (no Amazon prices shared yet) wasn't
  // really searched: it isn't listed as a marketplace, nor named as left out of
  // the comparison. It never counts towards the median either way.
  const shown = results.filter((r) => !(r.snapshot && r.status === "ok" && r.listings.length === 0));
  // Pass the FULL results, failures included. Passing only the ok ones would
  // silently re-enable the biased comparison this design exists to prevent.
  const analysis = withReportFlags(analyse(shown, { currency: opts.currency, query: q }), listings, context.upheldReports);
  return {
    query: q,
    listings: shopperOrder(listings, analysis.identities),
    sources: shown.map((r) => ({
      source: r.source,
      status: r.status,
      count: r.listings.length,
      detail: r.detail,
    })),
    analysis,
    // Amazon gets a search link only while it isn't answering as a live source.
    linkOut: linkOutTargets(q, { amazon: !results.some((r) => r.source === "amazon" && r.status === "ok" && !r.snapshot) }),
  };
}

export async function searchAll(
  query: string,
  sources: MarketplaceSource[],
  opts: SearchOptions = {},
  context: { upheldReports?: ReadonlyMap<string, number> } = {},
): Promise<SearchResponse> {
  const q = query.trim();
  if (!q) {
    return {
      query: q,
      listings: [],
      sources: [],
      analysis: {
        status: "insufficient_sample",
        reason: "No query.",
        coverage: [],
        flags: [],
        degraded: [],
        notConfigured: [],
        excludedFromComparison: [],
        priceChecked: [],
        comparisons: {},
        notCompared: {},
        identities: {},
        reportsChecked: false,
      },
      linkOut: [],
    };
  }
  return assembleSearch(q, await Promise.all(startSearch(q, sources, opts)), opts, context);
}

function withReportFlags(a: Analysis, listings: Listing[], upheld?: ReadonlyMap<string, number>): Analysis {
  // Passed at all means the decision log was read: no flags is then a real "none upheld".
  if (!upheld) return a;
  return { ...a, reportsChecked: true, flags: [...a.flags, ...upheldReportFlags(listings, upheld)] };
}
