/**
 * lib/marketplace/sources/types.ts — the seam every marketplace plugs into.
 *
 * The contract has one unusual rule, and it is the important one:
 *
 *   SEARCH MUST NOT THROW.
 *
 * A source that cannot answer returns a SourceResult with a non-ok status and
 * an empty list. It never rejects. The reason is that search fans out across
 * several sources at once, and a rejected promise is trivially easy to turn
 * into "drop that one and carry on" — which is exactly the silent-degradation
 * bug that must not exist here, because the anomaly check has to KNOW a source
 * is missing in order to refuse to compare prices.
 *
 * Returning a typed failure makes that information impossible to lose by
 * accident. Throwing makes losing it the path of least resistance.
 */

import type { SearchOptions, SourceResult, MarketplaceId } from "../types";

export interface MarketplaceSource {
  readonly id: MarketplaceId;
  /**
   * Search this marketplace. Resolves with a typed result in every case,
   * including failure — see the note above.
   */
  search(query: string, opts?: SearchOptions): Promise<SourceResult>;
}
