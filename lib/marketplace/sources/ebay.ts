/**
 * lib/marketplace/sources/ebay.ts — the first real marketplace.
 *
 * WHY EBAY FIRST
 * It is the only one of the three originally wanted that can be used properly.
 * The Browse API is public, documented, and authenticates with APPLICATION
 * credentials — a client-credentials token, no user login — which fits a site
 * that deliberately has no accounts.
 *
 * The other two do not work out, and it is better to say so than to ship a
 * scraper that dies on demo day:
 *
 *   Amazon         The Product Advertising API needs an Associates account that
 *                  makes qualifying sales within 180 days or access is revoked.
 *                  Scraping is against their terms and actively blocked.
 *   Kleinanzeigen  No public API. Terms forbid automated access, and systematic
 *                  extraction runs into the German sui generis database right
 *                  (UrhG s.87b) — a poor position to demo from in Germany.
 *
 * Licensed alternatives that DO have APIs: Etsy, Discogs, Bol.com, and the
 * affiliate feed networks (Awin, CJ) whose entire purpose is handing you
 * product data you are allowed to use.
 *
 * ONE USEFUL COINCIDENCE
 * The Browse API returns `seller.feedbackScore` and `seller.feedbackPercentage`
 * on each item, so the buyer view and the seller-trust view come from a single
 * integration. That feedback number is the WEAK tier: self-contained to one
 * platform and not independently checkable. lib/footprint calls that kind of
 * evidence `self_asserted` for good reason — crossing it with a second platform
 * is what the SigPath half adds.
 */

import type { Condition, Listing, Money, SearchOptions, SourceResult } from "../types";
import type { MarketplaceSource } from "./types";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const SCOPE = "https://api.ebay.com/oauth/api_scope";

/** eBay condition strings -> our buckets. Unknown maps to "unknown", never "new". */
function mapCondition(c?: string): Condition {
  const s = (c ?? "").toLowerCase();
  if (s.includes("refurbish")) return "refurbished";
  if (s.includes("new")) return "new";
  if (s.includes("used") || s.includes("pre-owned") || s.includes("good")) return "used";
  return "unknown";
}

/** "19.99" -> 1999 minor units, without going through a float multiply. */
export function toMinorUnits(value: string): number | null {
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number((m[2] ?? "0").padEnd(2, "0"));
  return major * 100 + minor;
}

function money(v?: { value?: string; currency?: string }): Money | undefined {
  if (!v?.value || !v.currency) return undefined;
  const amount = toMinorUnits(v.value);
  return amount === null ? undefined : { amount, currency: v.currency.toUpperCase() };
}

interface EbayItemSummary {
  itemId?: string;
  title?: string;
  itemWebUrl?: string;
  price?: { value?: string; currency?: string };
  shippingOptions?: { shippingCost?: { value?: string; currency?: string } }[];
  condition?: string;
  image?: { imageUrl?: string };
  seller?: { username?: string; feedbackScore?: number; feedbackPercentage?: string };
  itemCreationDate?: string;
}

export class EbaySource implements MarketplaceSource {
  readonly id = "ebay" as const;

  /** Cached application token. Not per-user — there are no users. */
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private credentials(): { id: string; secret: string; marketplace: string } | null {
    const id = this.env.EBAY_CLIENT_ID?.trim();
    const secret = this.env.EBAY_CLIENT_SECRET?.trim();
    if (!id || !secret) return null;
    return { id, secret, marketplace: this.env.EBAY_MARKETPLACE_ID?.trim() || "EBAY_DE" };
  }

  private async accessToken(id: string, secret: string): Promise<string> {
    // 60s of slack so a token cannot expire between the check and the call.
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    });

    if (!res.ok) {
      throw new Error(`token request returned ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("token response had no access_token");

    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000,
    };
    return this.token.value;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SourceResult> {
    const creds = this.credentials();
    if (!creds) {
      // Expected before the developer account exists. Explicitly NOT an error:
      // the search still runs, and the anomaly check knows to withhold its
      // price verdict rather than compare against a partial sample.
      return {
        source: this.id,
        status: "not_configured",
        listings: [],
        detail: "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are not set.",
      };
    }

    try {
      const token = await this.accessToken(creds.id, creds.secret);
      const url =
        `${BROWSE_URL}?q=${encodeURIComponent(query)}` +
        `&limit=${Math.min(opts.limit ?? 20, 200)}`;

      const res = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": creds.marketplace,
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });

      if (res.status === 429) {
        return {
          source: this.id,
          status: "rate_limited",
          listings: [],
          detail: "eBay returned 429.",
        };
      }
      if (!res.ok) {
        return {
          source: this.id,
          status: "error",
          listings: [],
          detail: `eBay returned ${res.status}: ${(await res.text()).slice(0, 160)}`,
        };
      }

      const body = (await res.json()) as { itemSummaries?: EbayItemSummary[] };
      const listings: Listing[] = [];

      for (const it of body.itemSummaries ?? []) {
        const price = money(it.price);
        // A listing whose price we cannot parse is dropped rather than guessed
        // at. A wrong price here becomes a wrong median for everyone else.
        if (!price || !it.itemId || !it.itemWebUrl) continue;

        const pct = it.seller?.feedbackPercentage;
        listings.push({
          id: it.itemId,
          source: this.id,
          title: it.title ?? "(untitled)",
          url: it.itemWebUrl,
          price,
          shipping: money(it.shippingOptions?.[0]?.shippingCost),
          condition: mapCondition(it.condition),
          imageUrl: it.image?.imageUrl,
          seller: {
            handle: it.seller?.username ?? "unknown",
            feedbackScore: it.seller?.feedbackScore,
            feedbackPercentage: pct === undefined ? undefined : Number(pct),
          },
          listedAt: it.itemCreationDate
            ? Math.floor(Date.parse(it.itemCreationDate) / 1000)
            : undefined,
        });
      }

      return { source: this.id, status: "ok", listings };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Never throws — see sources/types.ts. A rejected promise here would make
      // it far too easy for a caller to drop this source silently.
      return {
        source: this.id,
        status: /timeout|abort/i.test(msg) ? "timeout" : "error",
        listings: [],
        detail: msg.slice(0, 200),
      };
    }
  }
}
