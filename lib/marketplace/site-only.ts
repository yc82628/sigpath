/**
 * lib/marketplace/site-only.ts — marketplaces whose listings stay on SigPath's
 * own pages.
 *
 * Shown to shoppers on the search page, each linking to the marketplace to buy,
 * but never sold on through the paid API and never sent to the shopping
 * assistant's AI model:
 *
 *   etsy        Etsy's API terms forbid reselling member data and AI use
 *               (lib/marketplace/etsy-terms.ts).
 *   aliexpress  Until its affiliate terms have been read for both uses, the
 *               cautious default is the same.
 *   amazon      Prices shoppers saw with the extension (sources/amazon-seen.ts):
 *               not Amazon's data to pass on, and not live.
 */

import type { LabelledSearch } from "./labelled-search";

export const SITE_ONLY = new Set(["etsy", "aliexpress", "amazon"]);

/** The search with every site-only listing and source removed: for the paid API and the AI assistant. */
export function withoutSiteOnly(result: LabelledSearch): LabelledSearch {
  return {
    ...result,
    listings: result.listings.filter((l) => !SITE_ONLY.has(l.source)),
    sources: result.sources.filter((s) => !SITE_ONLY.has(s.source)),
    bestCheckedDeals: result.bestCheckedDeals.filter((d) => !SITE_ONLY.has(d.listing.split(":")[0])),
  };
}
