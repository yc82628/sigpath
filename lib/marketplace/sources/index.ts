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
import { AmazonSeenSource } from "./amazon-seen";
import { AliExpressSource } from "./aliexpress";
import { FeedSource } from "./feed";
import { StubSource } from "./stub";

/**
 * The offline demo feed, with scams planted on purpose. On by default where
 * there may be no credentials (local development, previews), so search is
 * demonstrable with no keys at all. Off by default on the live site (Vercel
 * production): real shoppers must not see invented products. STUB_FEED=true
 * or =false overrides either default.
 */
export function demoFeedOn(env: Record<string, string | undefined> = process.env): boolean {
  const set = env.STUB_FEED?.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (set === "true") return true;
  if (set === "false") return false;
  return env.VERCEL_ENV !== "production";
}

export function defaultSources(env: Record<string, string | undefined> = process.env): MarketplaceSource[] {
  // The live marketplaces. idealo and Kleinanzeigen are covered as link-outs,
  // not sources — see registry.ts for why there is no API we may query.
  const list: MarketplaceSource[] = [
    new EbaySource(env),
    // Amazon's retired product API if its keys are still set, else the prices shoppers saw with the extension.
    env.AMAZON_ACCESS_KEY?.trim() && env.AMAZON_SECRET_KEY?.trim() ? new AmazonSource(env) : new AmazonSeenSource(env),
    // Etsy (sources/etsy.ts) is no longer searched: AliExpress replaced it.
    new AliExpressSource(env),
    new FeedSource(env),
  ];
  if (demoFeedOn(env)) {
    const delay = Number(env.STUB_DELAY_MS);
    list.push(new StubSource("EUR", Number.isFinite(delay) && delay > 0 ? Math.min(delay, 10_000) : 0));
  }
  return list;
}
