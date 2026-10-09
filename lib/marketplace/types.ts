/**
 * lib/marketplace/types.ts — shared vocabulary for cross-marketplace search.
 *
 * WHAT THIS HALF OF THE PRODUCT IS FOR
 * Searching several marketplaces at once is a convenience. The reason it is
 * also a SECURITY feature is that a scam signature which is invisible inside
 * one marketplace becomes obvious across several: the same item listed far
 * below its cross-platform median, or the same photograph appearing under three
 * different seller names. No individual marketplace can see either of those,
 * because each one only sees itself.
 *
 * That is the buyer-side half, and it needs nobody's participation. The
 * seller-side half — a seller proving they control accounts on several
 * platforms — reuses lib/footprint and the existing on-chain attestation path
 * unchanged.
 *
 * MONEY IS INTEGER MINOR UNITS
 * 19.99 EUR is { amount: 1999, currency: "EUR" }. Floats accumulate error the
 * moment you take a median or a ratio, and the whole anomaly check is ratios.
 *
 * NO ACCOUNTS ANYWHERE IN HERE
 * Nothing in this module takes a user id, sets a cookie, or persists anything
 * about who searched. A search is a pure function of its query. That is a
 * product decision (no login) and it is also why there is no PII to leak.
 */

/**
 * The marketplaces this product covers. Deliberately a short, fixed list rather
 * than an open-ended crawl: a small set of large retailers gives consistent,
 * comparable results, and every source added is an integration to keep working.
 *
 * `stub` is the offline feed — see sources/stub.ts.
 */
export type MarketplaceId =
  | "ebay"
  | "amazon"
  | "etsy"
  | "idealo"
  | "kleinanzeigen"
  /**
   * A licensed affiliate product feed (Awin, CJ, Tradedoubler, or any
   * Google-Shopping-style CSV). One integration that carries many merchants at
   * once, and the only route by which retailers without a public API can enter
   * this product legitimately. See sources/feed.ts.
   */
  | "feed"
  | "stub";

/**
 * How a marketplace can be reached, which is not the same question as whether
 * we want it. See lib/marketplace/registry.ts for the per-source verdict.
 */
export type AccessMode =
  /** A licensed API we can call for structured results. */
  | "api"
  /** No API we may use. We link the buyer to the site's own search instead. */
  | "link_out";

/**
 * Condition matters more than it looks. A used phone at half the price of a new
 * one is not an anomaly, it is a used phone — so the anomaly check compares
 * like with like and refuses to mix these buckets.
 */
export type Condition = "new" | "used" | "refurbished" | "unknown";

export interface Money {
  /** Integer minor units. 19.99 EUR -> 1999. */
  amount: number;
  /** ISO 4217, uppercase. */
  currency: string;
}

export interface SellerRef {
  /** Stable handle on that marketplace. Hashes to the SigPath subject. */
  handle: string;
  displayName?: string;
  /** The marketplace's own feedback count, if it publishes one. */
  feedbackScore?: number;
  /** 0..100, the marketplace's own positive percentage. */
  feedbackPercentage?: number;
  /** Unix seconds. A brand-new account with many listings is worth flagging. */
  memberSince?: number;
}

export interface Listing {
  /** Unique within its source. */
  id: string;
  source: MarketplaceId;
  title: string;
  /** Canonical link out to the marketplace. We never proxy a checkout. */
  url: string;
  price: Money;
  /** Shipping, when the source separates it. Added before comparison. */
  shipping?: Money;
  condition: Condition;
  imageUrl?: string;
  /**
   * Perceptual or exact hash of the primary image, when we have one. Equal
   * hashes across different sellers is the duplicate-listing signal.
   */
  imageHash?: string;
  /**
   * Why the photo was not compared, when it wasn't: a new item showing the
   * maker's photo, a marketplace stock photo, or a photo that didn't load.
   * Shown to the shopper in place of the photo check.
   */
  photoNote?: string;
  /**
   * The marketplace's own category for the listing, when it publishes one
   * (eBay's leaf category, e.g. "Konsolen"). Prices are only compared within the
   * category most of a search's results share: a game is not a cheap console.
   */
  category?: { id: string; name: string };
  seller: SellerRef;
  /** Unix seconds the listing went up, if published. */
  listedAt?: number;
}

/**
 * Why a source might not have contributed.
 *
 * THIS TYPE IS LOAD-BEARING. A source that failed must never be silently
 * dropped and the remaining results presented as if they were the whole
 * picture. That exact mistake — a rate-limited collector quietly skipped, a
 * score computed from what was left — produced three confidently wrong
 * benchmark runs in the footprint scorer. The same discipline applies here, and
 * it matters more, because a median taken over a biased subset will flag honest
 * listings as scams.
 */
export type SourceStatus =
  | "ok"
  /** No credentials configured. Expected in development; not an error. */
  | "not_configured"
  | "rate_limited"
  | "timeout"
  | "error";

export interface SourceResult {
  source: MarketplaceId;
  status: SourceStatus;
  listings: Listing[];
  /** Operator-facing detail. Safe to show; contains no user data. */
  detail?: string;
  /**
   * Whether this source's prices may enter the cross-marketplace median.
   * Set by the orchestrator from the source's own declaration (see
   * MarketplaceSource.priceComparable), on success AND failure alike, so the
   * analysis knows whether a missing source actually biases the sample.
   * Absent means comparable.
   */
  comparable?: boolean;
}

export interface SearchOptions {
  /** Max listings per source. */
  limit?: number;
  /** Currency to compare in. Listings in any other currency are set aside. */
  currency?: string;
  /** Per-source deadline. A slow source must not hold up the whole search. */
  timeoutMs?: number;
}

/**
 * A listing's identity ACROSS sources. A bare id is only unique within one
 * marketplace — eBay "123" and Etsy "123" are different items — and anything
 * that gates on identity (the checkout's "was this price checked?") must not
 * let one source's listing vouch for another's.
 */
export function listingKey(l: Pick<Listing, "source" | "id">): string {
  return `${l.source}:${l.id}`;
}

/**
 * A seller's identity across SigPath: marketplace plus handle, canonicalised
 * the same way subjectHash() canonicalises (lower-case, trimmed), so the key a
 * report is recorded under is the key a search looks up.
 */
export function sellerKey(source: string, handle: string): string {
  return `${source.toLowerCase()}:${handle.trim().toLowerCase()}`;
}

/** Total price a buyer actually pays: item + shipping, same currency. */
export function totalPrice(l: Listing): Money {
  if (!l.shipping) return l.price;
  if (l.shipping.currency !== l.price.currency) {
    // Cannot add these. Returning the item price alone would understate the
    // total and make the listing look cheaper than it is — which is precisely
    // the direction that produces a false scam flag.
    return l.price;
  }
  return { amount: l.price.amount + l.shipping.amount, currency: l.price.currency };
}

/** Format minor units for display. Never used for comparison. */
export function formatMoney(m: Money): string {
  return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
}
