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
   * False when this marketplace's prices describe a different kind of goods
   * from the retail sources, so pooling them into one median would be wrong.
   *
   * Etsy is the case that forced this: a search for a laptop returns sleeves,
   * stickers and handmade cases at a tenth of the price. Pooled, every one of
   * them would be flagged "well below the median" and the median itself would
   * sink. A cross-border marketplace with a different price level has the same
   * problem from the other direction.
   *
   * Non-comparable listings are still shown, and still get every check that
   * does not depend on a price comparison. They just never reach the median.
   * Defaults to true.
   */
  readonly priceComparable?: boolean;
  /**
   * Search this marketplace. Resolves with a typed result in every case,
   * including failure — see the note above.
   */
  search(query: string, opts?: SearchOptions): Promise<SourceResult>;
}
