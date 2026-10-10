/**
 * lib/marketplace/etsy-terms.ts — where Etsy's data may go.
 *
 * Etsy's API Terms of Use (etsy.com/legal/api) set the limits, and SigPath
 * keeps to them in code rather than by promise:
 *
 *   - The site shows Etsy's required notice (ETSY_NOTICE) whenever Etsy is on.
 *   - Etsy listings stay on SigPath's own pages, where each links to Etsy to
 *     buy. They are never sold on through the paid API ("Transfer or
 *     commercialize ... Etsy Member content or data to any third party") and
 *     never sent to the shopping assistant's AI model (no Etsy content "for
 *     purposes of ... machine learning [or] training artificial intelligence
 *     models" without Etsy's written consent).
 *   - SigPath never checks out an Etsy listing (no circumventing "the Etsy
 *     checkout process"): see lib/checkout/eligibility.ts.
 *   - Searches aren't stored (fetches are `no-store`, nothing is cached).
 */

import type { LabelledSearch } from "./labelled-search";

/** Etsy's wording, exactly as its API Terms require it. */
export const ETSY_NOTICE =
  "The term 'Etsy' is a trademark of Etsy, Inc. This Application uses Etsy's API, but is not endorsed or certified by Etsy.";

/** Etsy is searched only with both keys set (sources/etsy.ts). */
export const etsyOn = (env: Record<string, string | undefined> = process.env) =>
  !!(env.ETSY_KEYSTRING?.trim() && env.ETSY_SHARED_SECRET?.trim());

/** A search with every Etsy listing and the Etsy source removed: for the paid API and the AI assistant. */
export function withoutEtsy(result: LabelledSearch): LabelledSearch {
  return {
    ...result,
    listings: result.listings.filter((l) => l.source !== "etsy"),
    sources: result.sources.filter((s) => s.source !== "etsy"),
    bestCheckedDeals: result.bestCheckedDeals.filter((d) => !d.listing.startsWith("etsy:")),
  };
}
