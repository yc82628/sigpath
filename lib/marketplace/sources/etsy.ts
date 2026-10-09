/**
 * lib/marketplace/sources/etsy.ts — Etsy Open API v3.
 *
 * WHY ETSY
 * It is the closest thing to eBay's model among marketplaces with a genuinely
 * open API: independent sellers running their own shops, public listings, and a
 * search endpoint (findAllListingsActive) that needs only an application key —
 * no user OAuth, which fits a site with no accounts. It also suits the
 * verification half of this product unusually well: Etsy sellers routinely
 * cross-list on eBay, which is exactly the case where proving one person
 * controls both accounts is worth something.
 *
 * WHY ITS PRICES STAY OUT OF THE MEDIAN
 * Etsy sells handmade, vintage and craft goods. Search it for a laptop and you
 * get sleeves, stickers and hand-stitched cases at a tenth of the price. Pooled
 * into the cross-marketplace median, every one of those would be flagged
 * "well below the median" — a false scam flag on an honest maker — and the
 * median itself would sink, blunting the check for everyone else. So this
 * source declares `priceComparable = false`. Its listings are shown, and still
 * get every check that does not depend on price; they never reach the median.
 *
 * TWO CALLS PER SEARCH
 * findAllListingsActive returns listings with a shop_id but no shop name, no
 * shop age and no images. getListingsByListingIds (the batch endpoint) returns
 * the same listings with `includes=Shop,Images`. One extra call for up to 100
 * listings buys the seller's display name, their shop's creation date — which
 * makes the new-account check work on real data — and a thumbnail.
 *
 * The enrichment is best-effort. If the batch call fails the listings are still
 * returned, with the shop id as the seller and a note saying details are
 * missing. Losing a thumbnail must never cost the buyer the listing.
 *
 * FIELD SHAPES are taken from Etsy's published OpenAPI spec, not from memory:
 *   price           Money { amount, divisor, currency_code } — amount/divisor
 *   when_made       enum: made_to_order, 2020_2026, 2010_2019, ... before_1700
 *   Shop            shop_name, create_date (epoch s), review_count (past year)
 *   ListingImage    url_570xN
 */

import type { Condition, Listing, SearchOptions, SourceResult } from "../types";
import type { ListingProof, MarketplaceSource } from "./types";

const BASE = "https://openapi.etsy.com/v3/application";

/** Etsy's Money: `amount / divisor` in the listing's currency. */
interface EtsyMoney {
  amount?: number;
  divisor?: number;
  currency_code?: string;
}

interface EtsyListing {
  listing_id?: number;
  title?: string;
  url?: string;
  price?: EtsyMoney;
  shop_id?: number;
  when_made?: string;
  is_supply?: boolean;
  creation_timestamp?: number;
  original_creation_timestamp?: number;
  shop?: { shop_name?: string; create_date?: number; review_count?: number };
  images?: { url_570xN?: string }[];
}

/**
 * Money -> integer minor units, in the two-decimal convention the rest of the
 * marketplace layer uses. Integer arithmetic until the final division, and null
 * for anything that cannot be a real price — a divisor of zero or a missing
 * amount must drop the listing, not become 0.00 or Infinity in someone's median.
 */
export function etsyMoneyToMinorUnits(m?: EtsyMoney): number | null {
  if (!m || typeof m.amount !== "number" || typeof m.divisor !== "number") return null;
  if (m.divisor <= 0 || m.amount <= 0) return null;
  return Math.round((m.amount * 100) / m.divisor);
}

/**
 * Etsy has no condition field; `when_made` is the nearest proxy.
 *
 *   made_to_order, 2020_2026  -> new       (recently made, not previously owned)
 *   2007_2009 .. 2010_2019    -> unknown   (could be an unsold maker's piece or
 *                                           a lightly used one; do not guess)
 *   before 2007               -> used      (Etsy's vintage threshold is 20+ years)
 *
 * The mapping barely affects the median, since Etsy is excluded from it, but it
 * is shown to the buyer, so it must not overclaim "new".
 */
export function etsyCondition(whenMade?: string): Condition {
  if (!whenMade) return "unknown";
  if (whenMade === "made_to_order" || whenMade === "2020_2026") return "new";
  if (whenMade === "2010_2019" || whenMade === "2007_2009") return "unknown";
  return "used";
}

export class EtsySource implements MarketplaceSource {
  readonly id = "etsy" as const;
  /** Handmade and vintage goods; see the header note. */
  readonly priceComparable = false;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private apiKey(): string | null {
    const keystring = this.env.ETSY_KEYSTRING?.trim();
    const secret = this.env.ETSY_SHARED_SECRET?.trim();
    if (!keystring || !secret) return null;
    // Etsy requires BOTH, colon-separated, on every v3 request. The keystring
    // alone — what older guides show — is rejected.
    return `${keystring}:${secret}`;
  }

  /**
   * Best-effort: shop details and images for a set of listing ids. Returns an
   * empty map on any failure rather than throwing, and says so via `ok`.
   */
  private async enrich(
    ids: number[],
    key: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; byId: Map<number, EtsyListing> }> {
    const byId = new Map<number, EtsyListing>();
    if (!ids.length) return { ok: true, byId };
    try {
      const url =
        `${BASE}/listings/batch?listing_ids=${ids.join(",")}` + `&includes=${["Shop", "Images"].join(",")}`;
      const res = await this.fetchImpl(url, {
        headers: { "x-api-key": key },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, byId };
      const body = (await res.json()) as { results?: EtsyListing[] };
      for (const l of body.results ?? []) {
        if (typeof l.listing_id === "number") byId.set(l.listing_id, l);
      }
      return { ok: true, byId };
    } catch {
      return { ok: false, byId };
    }
  }

  /** For the verified-seller claim: a listing's shop (the handle search uses) and its text. */
  async listingForProof(listingId: string, timeoutMs = 8000): Promise<ListingProof> {
    const key = this.apiKey();
    if (!key) return { ok: false, error: "Etsy isn't configured on this SigPath instance." };
    if (!/^\d{5,15}$/.test(listingId)) return { ok: false, error: "That isn't an Etsy listing id (the number in the listing's URL)." };
    try {
      const res = await this.fetchImpl(`${BASE}/listings/${listingId}`, {
        headers: { "x-api-key": key },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return { ok: false, error: "Etsy has no listing with that id." };
      if (!res.ok) return { ok: false, error: `Etsy returned ${res.status}.` };
      const l = (await res.json()) as EtsyListing & { description?: string; state?: string };
      if (typeof l.shop_id !== "number") return { ok: false, error: "Etsy didn't say which shop sells that listing." };
      if (l.state && l.state !== "active") return { ok: false, error: "That listing isn't active." };
      return { ok: true, handle: `shop:${l.shop_id}`, text: [l.title, l.description].filter(Boolean).join("\n") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Etsy couldn't be reached." };
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SourceResult> {
    const key = this.apiKey();
    if (!key) {
      return {
        source: this.id,
        status: "not_configured",
        listings: [],
        detail: "ETSY_KEYSTRING / ETSY_SHARED_SECRET are not set.",
      };
    }

    const timeoutMs = opts.timeoutMs ?? 8000;

    try {
      const url =
        `${BASE}/listings/active?keywords=${encodeURIComponent(query)}` +
        `&limit=${Math.min(Math.max(opts.limit ?? 20, 1), 100)}`; // spec: 1..100

      const res = await this.fetchImpl(url, {
        headers: { "x-api-key": key },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 429) {
        return { source: this.id, status: "rate_limited", listings: [], detail: "Etsy returned 429." };
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        return {
          source: this.id,
          status: "error",
          listings: [],
          detail:
            res.status === 401 || res.status === 403
              ? `Etsy rejected the key (${res.status}). The x-api-key must be "keystring:shared_secret", and the app must be approved on developers.etsy.com. Raw: ${text}`
              : `Etsy returned ${res.status}: ${text}`,
        };
      }

      const body = (await res.json()) as { results?: EtsyListing[] };
      const raw = body.results ?? [];

      const ids = raw.map((l) => l.listing_id).filter((id): id is number => typeof id === "number");
      const { ok: enriched, byId } = await this.enrich(ids, key, timeoutMs);

      const listings: Listing[] = [];
      for (const l of raw) {
        const amount = etsyMoneyToMinorUnits(l.price);
        const currency = l.price?.currency_code?.toUpperCase();
        // Unpriceable listings are dropped, not guessed at.
        if (amount === null || !currency || typeof l.listing_id !== "number" || !l.url) continue;

        const extra = byId.get(l.listing_id);
        const shop = extra?.shop;

        listings.push({
          id: String(l.listing_id),
          source: this.id,
          title: l.title ?? "(untitled)",
          url: l.url,
          price: { amount, currency },
          // Shipping is per-destination on Etsy and not in the search result.
          // Leaving it undefined is honest; inventing a zero would understate
          // the total and flatter the price.
          condition: etsyCondition(l.when_made),
          imageUrl: extra?.images?.[0]?.url_570xN,
          seller: {
            // The shop ID, not the shop NAME, is the stable handle. Etsy lets a
            // seller rename their shop; an attestation keyed to a name would be
            // orphaned by a rename, while the numeric id never changes. The
            // name is shown, the id is what identity hangs on.
            handle: `shop:${l.shop_id ?? "unknown"}`,
            displayName: shop?.shop_name,
            feedbackScore: shop?.review_count,
            // review_average is a 1-5 star mean, NOT a percentage of positive
            // feedback. Converting it to one would put a figure on screen that
            // means something different from eBay's number beside it.
            memberSince: shop?.create_date,
          },
          listedAt: l.original_creation_timestamp ?? l.creation_timestamp,
        });
      }

      return {
        source: this.id,
        status: "ok",
        listings,
        detail: enriched
          ? "Handmade and vintage: shown, but kept out of the price comparison."
          : "Handmade and vintage: shown, but kept out of the price comparison. Shop details could not be loaded, so seller names and account age are missing.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        source: this.id,
        status: /timeout|abort/i.test(msg) ? "timeout" : "error",
        listings: [],
        detail: msg.slice(0, 400),
      };
    }
  }
}
