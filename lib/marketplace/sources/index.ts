/**
 * lib/marketplace/sources/index.ts — the one list of sources a search uses.
 *
 * The search page and the API route each used to build this list themselves.
 * Two copies of a list are two lists: the day a source is added to one and not
 * the other, the page and the API quietly search different marketplaces and
 * report different medians for the same query. One function, imported by both.
 *
 * Built per call rather than cached at module load, so credentials added to
 * .env.local take effect on the next request instead of the next deploy.
 */

import type { MarketplaceSource } from "./types";
import { EbaySource } from "./ebay";
import { AmazonSource } from "./amazon";
import { EtsySource } from "./etsy";
import { FeedSource } from "./feed";
import { StubSource } from "./stub";

export function defaultSources(env: Record<string, string | undefined> = process.env): MarketplaceSource[] {
  // The live marketplaces. idealo and Kleinanzeigen are covered as link-outs,
  // not sources — see registry.ts for why there is no API we may query.
  const list: MarketplaceSource[] = [
    new EbaySource(env),
    new AmazonSource(env),
    new EtsySource(env),
    new FeedSource(env),
  ];
  // The offline feed stays on until turned off, so search is demonstrable with
  // no credentials at all. Set STUB_FEED=false once real sources answer.
  if (env.STUB_FEED !== "false") {
    const delay = Number(env.STUB_DELAY_MS);
    list.push(new StubSource("EUR", Number.isFinite(delay) && delay > 0 ? Math.min(delay, 10_000) : 0));
  }
  return list;
}
