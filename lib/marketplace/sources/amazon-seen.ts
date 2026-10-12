/**
 * lib/marketplace/sources/amazon-seen.ts — Amazon.de, as SigPath shoppers saw it.
 *
 * The prices the SigPath extension reported from Amazon pages its users opened
 * (lib/extension/seen.ts). Searched in place of Amazon's product API while
 * that isn't open to SigPath. Never price-comparable: a price someone saw, up
 * to a week ago, and sent by anyone with the extension, so it shows as "seen on
 * Amazon" and is never checked, never in the median, never in the checkout.
 * Its link is Amazon's own product page, where the real price is.
 */

import type { SearchOptions, SourceResult } from "../types";
import type { MarketplaceSource } from "./types";
import { SeenStore, seenListing } from "../../extension/seen";
import { amazonTag } from "../../legal/site";

export class AmazonSeenSource implements MarketplaceSource {
  readonly id = "amazon" as const;
  readonly priceComparable = false;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly store: SeenStore = SeenStore.fromEnv(env),
    private readonly now: () => number = Date.now,
  ) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SourceResult> {
    try {
      const seen = await this.store.search(query, this.now(), Math.min(opts.limit ?? 20, 20));
      const tag = amazonTag(this.env);
      return {
        source: this.id,
        status: "ok",
        snapshot: true,
        listings: seen.map((s) => seenListing(s, tag)),
        detail: "Prices SigPath shoppers saw on Amazon.de with the extension in the last week: not live, not price-checked.",
      };
    } catch (err) {
      return { source: this.id, status: "error", listings: [], snapshot: true, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }
}
