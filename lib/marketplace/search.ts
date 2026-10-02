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
import { sellerKey, totalPrice } from "./types";
import type { MarketplaceSource } from "./sources/types";
import { analyse, type Analysis, type Flag } from "./anomaly";
import { linkOutTargets } from "./registry";

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
  linkOut: { id: string; label: string; url: string; note?: string }[];
}

/** Cheapest first, by what the buyer actually pays. */
function byTotalAscending(a: Listing, b: Listing): number {
  return totalPrice(a).amount - totalPrice(b).amount;
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
      },
      linkOut: [],
    };
  }

  // allSettled, not all: one source rejecting must not abort the others. A
  // conforming source never rejects (see sources/types.ts), but a third-party
  // one added later might, and that must degrade to a typed failure rather
  // than taking the whole search down.
  const settled = await Promise.allSettled(sources.map((s) => s.search(q, opts)));

  const results: SourceResult[] = settled.map((outcome, i) => {
    // Comparability comes from the SOURCE, not the outcome, and is attached on
    // both paths: the analysis needs to know whether a source that failed was
    // one whose absence biases the median, and a thrown error carries nothing.
    const comparable = sources[i].priceComparable !== false;
    return outcome.status === "fulfilled"
      ? { ...outcome.value, comparable }
      : {
          source: sources[i].id,
          status: "error" as const,
          listings: [],
          comparable,
          detail:
            outcome.reason instanceof Error
              ? `source threw: ${outcome.reason.message.slice(0, 160)}`
              : "source threw a non-Error",
        };
  });

  const listings = results.flatMap((r) => r.listings).sort(byTotalAscending);

  return {
    query: q,
    listings,
    sources: results.map((r) => ({
      source: r.source,
      status: r.status,
      count: r.listings.length,
      detail: r.detail,
    })),
    // Pass the FULL results, failures included. Passing only the ok ones would
    // silently re-enable the biased comparison this design exists to prevent.
    analysis: withReportFlags(analyse(results, { currency: opts.currency }), listings, context.upheldReports),
    linkOut: linkOutTargets(q),
  };
}

function withReportFlags(a: Analysis, listings: Listing[], upheld?: ReadonlyMap<string, number>): Analysis {
  if (!upheld || upheld.size === 0) return a;
  return { ...a, flags: [...a.flags, ...upheldReportFlags(listings, upheld)] };
}
