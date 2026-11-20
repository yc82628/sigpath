/**
 * lib/cart/requote.ts — a fresh, signed price for an item in the cart.
 *
 * A quote lives thirty minutes; a cart lasts longer. SigPath only pays for a
 * price it checked, so an older item isn't simply re-signed: it is checked
 * again exactly as the search page checks it. A new search for the item's
 * model, the listing found again among today's results, compared with today's
 * identical listings, the same flags and the same checkout rules, and only
 * then a new signed quote. An item that's no longer in the results, or no
 * longer passes, gets the reason instead and stays a "Buy on eBay" item.
 */

import { searchAll } from "../marketplace/search";
import { defaultSources } from "../marketplace/sources";
import { labelSearch } from "../marketplace/label";
import { shortQuery } from "../marketplace/price-check";
import { listingKey, sellerKey, totalPrice, type Listing } from "../marketplace/types";
import { checkoutEligibility, priceCheckFor } from "../checkout/eligibility";
import { signQuote, QUOTE_TTL_SECONDS } from "../checkout/quote";
import { eurUsdRate, toTokenBaseUnits, type FxRate } from "../checkout/fx";
import { defaultPayToken, type PayToken } from "../chains/solana/tokens";
import { serviceFeeBps, withServiceFee } from "../checkout/fee";
import { DecisionLog } from "../reports/reports";
import { VerifiedSellerLog, badgeFor } from "../sellers/verified-log";
import { BusinessLog, businessIndex, verifiedPhotoFlags } from "../sellers/business";
import type { SearchResponse as SearchResult } from "../marketplace/search";

export interface RequoteItem {
  source: string;
  id: string;
  title: string;
}

export type Requote =
  | { ok: true; key: string; token: string; usdc?: string; expiresAt: number; amount: number; currency: string }
  | { ok: false; key: string; reason: string };

/** "150.00 EURC": rounded UP to the cent, as on the search page, so checkout never shows more. */
function coinPreview(baseUnits: bigint, coin: PayToken): string {
  return `${(Number((baseUnits + 9_999n) / 10_000n) / 100).toFixed(2)} ${coin}`;
}

export interface RequoteDeps {
  /** One search, as the search page runs it. */
  search(query: string): Promise<{ result: SearchResult; isVerified: (l: Listing) => boolean; flagsExtra: (r: SearchResult) => void }>;
  rate(): Promise<FxRate | null>;
  now(): number;
}

export function defaultRequoteDeps(env: Record<string, string | undefined> = process.env): RequoteDeps {
  return {
    async search(query) {
      const [upheldReports, badgeEntries, businessEntries] = await Promise.all([
        DecisionLog.fromEnv(env).upheldCounts(),
        VerifiedSellerLog.fromEnv(env).all(),
        BusinessLog.fromEnv(env).all(),
      ]);
      const result = await searchAll(query, defaultSources(env), { limit: 50 }, { upheldReports });
      const businesses = businessIndex(businessEntries, badgeEntries, upheldReports);
      return {
        result,
        isVerified: (l: Listing) => badgeFor(sellerKey(l.source, l.seller.handle), badgeEntries, upheldReports) !== null,
        // Same as the search page: a verified business's photo under an unlinked account.
        flagsExtra: (r) => {
          r.analysis = { ...r.analysis, flags: [...r.analysis.flags, ...verifiedPhotoFlags(r.listings, businesses)] };
        },
      };
    },
    rate: () => eurUsdRate(env).catch(() => null),
    now: () => Date.now(),
  };
}

export async function requoteItem(item: RequoteItem, deps: RequoteDeps, env: Record<string, string | undefined> = process.env): Promise<Requote> {
  const key = `${item.source}:${item.id}`;
  if (item.source === "stub" || item.source === "ebay") {
    const query = shortQuery(item.title);
    if (!query) return { ok: false, key, reason: "This item can't be searched again." };
    const { result, isVerified, flagsExtra } = await deps.search(query);
    flagsExtra(result);
    const listing = result.listings.find((l) => listingKey(l) === key);
    if (!listing) return { ok: false, key, reason: "It isn't in today's search results, so it couldn't be checked again." };
    const labelled = labelSearch(result, isVerified);
    const label = labelled.labelOf(listing);
    if (label.verdict !== "checked") return { ok: false, key, reason: `Not SigPath-checked today: ${label.headline}.` };
    const e = checkoutEligibility(listing, labelled.flagsOf(listing), priceCheckFor(listing, result.analysis));
    if (!e.eligible) return { ok: false, key, reason: e.reason };
    const total = totalPrice(listing);
    const token = signQuote(
      { source: listing.source, id: listing.id, url: listing.url, title: listing.title, seller: listing.seller.handle, amount: total.amount, currency: total.currency },
      env,
      deps.now(),
    );
    if (!token) return { ok: false, key, reason: "Checkout isn't set up here." };
    // The preview in the coin the checkout starts with: EURC for a euro price, USDC for a dollar one, so no rate is needed.
    const coin = defaultPayToken([total.currency]);
    const itemBase = toTokenBaseUnits(total.amount, total.currency, coin, null);
    return {
      ok: true,
      key,
      token,
      usdc: itemBase === null ? undefined : coinPreview(withServiceFee(itemBase, serviceFeeBps(env)).total, coin),
      expiresAt: deps.now() + QUOTE_TTL_SECONDS * 1000,
      amount: total.amount,
      currency: total.currency,
    };
  }
  return { ok: false, key, reason: "SigPath's checkout doesn't cover this marketplace." };
}
