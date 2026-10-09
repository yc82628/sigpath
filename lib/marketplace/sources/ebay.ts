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
import type { ListingProof, MarketplaceSource } from "./types";

/**
 * Sandbox and production are separate accounts with separate keysets.
 *
 * WHY SANDBOX IS WORTH SUPPORTING
 * A production keyset is created DISABLED. eBay only enables it once you have
 * subscribed to — or explicitly opted out of — marketplace account deletion
 * notifications, which is a compliance step with its own form. A sandbox keyset
 * has no such gate and works the moment it is created, so the integration can
 * be proven end to end while production clearance is still pending.
 *
 * Sandbox returns eBay's own test inventory, not real listings. It proves the
 * auth, the request shape and the parsing; it says nothing about result
 * quality, and its prices must never be presented as real market data.
 *
 * Note the SCOPE string stays on api.ebay.com in both environments — it is an
 * identifier, not an address, and "fixing" it to the sandbox host is a common
 * way to get an unhelpful invalid_scope error.
 */
const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
} as const;

export type EbayEnv = keyof typeof HOSTS;

const SCOPE = "https://api.ebay.com/oauth/api_scope";

/**
 * eBay is asked for at least this many results. A price is only compared with
 * at least 5 listings of the same model and configuration, and a broad search
 * ("ThinkPad X1") spreads 20 results over too many generations and storage
 * sizes for that. One call either way; eBay allows up to 200.
 */
export const EBAY_MIN_RESULTS = 50;

/**
 * eBay's condition -> our buckets. Unknown maps to "unknown", never "new".
 *
 * The numeric conditionId comes first: it is the same on every eBay site,
 * while the text is translated ("Gebraucht" on EBAY_DE, "Occasion" on EBAY_FR)
 * and would otherwise leave most German listings uncompared.
 * https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html
 */
export function mapCondition(c?: string, conditionId?: string): Condition {
  const id = Number(conditionId);
  if (Number.isInteger(id) && id > 0) {
    if (id === 1000 || id === 1500) return "new"; // new; new other (open box)
    if (id >= 2000 && id <= 2500) return "refurbished"; // certified, excellent, very good, good, seller refurbished
    if (id === 1750 || (id >= 2750 && id <= 6000)) return "used"; // new with defects, like new, pre-owned grades, used
    return "unknown"; // 7000 for parts or not working: never compared with working units
  }
  const s = (c ?? "").toLowerCase();
  if (s.includes("refurbish") || s.includes("generalüberholt") || s.includes("reconditionn")) return "refurbished";
  if (s.includes("neuwertig") || s.includes("gebraucht") || s.includes("used") || s.includes("pre-owned") || s.includes("occasion") || s.includes("good")) return "used";
  if (s.includes("new") || s.startsWith("neu") || s.includes("neuf")) return "new";
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
  conditionId?: string;
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

  private credentials():
    | { id: string; secret: string; marketplace: string; env: EbayEnv }
    | null {
    const id = this.env.EBAY_CLIENT_ID?.trim();
    const secret = this.env.EBAY_CLIENT_SECRET?.trim();
    if (!id || !secret) return null;

    // Default to production. Sandbox is opt-in, because silently serving eBay's
    // test inventory as if it were the real market would be worse than not
    // running at all.
    const raw = (this.env.EBAY_ENV?.trim() || "production").toLowerCase();
    const env: EbayEnv = raw === "sandbox" ? "sandbox" : "production";

    return {
      id,
      secret,
      marketplace: this.env.EBAY_MARKETPLACE_ID?.trim() || "EBAY_DE",
      env,
    };
  }

  private async accessToken(id: string, secret: string, env: EbayEnv): Promise<string> {
    // 60s of slack so a token cannot expire between the check and the call.
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    const res = await this.fetchImpl(`${HOSTS[env]}/identity/v1/oauth2/token`, {
      // Next.js would otherwise store this response and hand back an expired token.
      cache: "no-store",
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    });

    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      // The failure everyone hits first. A production keyset is created
      // DISABLED and stays that way until the marketplace account deletion
      // notification compliance step is done — and the raw error does not say
      // so, which turns a ten-minute form into an afternoon of key-checking.
      if (/invalid_client|unauthorized_client|disabled/i.test(text)) {
        // Front-load the actionable part: this string gets truncated for
        // display, and the advice is worth more than the raw body.
        throw new Error(
          `eBay rejected these credentials (${res.status}). A new PRODUCTION keyset stays ` +
            `disabled until the marketplace account deletion notification step is completed ` +
            `on the Application Keys page. Also check EBAY_ENV matches the keyset. Raw: ${text}`,
        );
      }
      throw new Error(`token request returned ${res.status}: ${text}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("token response had no access_token");

    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000,
    };
    return this.token.value;
  }

  /** Notification signing keys, by key id. They rotate rarely; cached for an hour. */
  private notificationKeys = new Map<string, { key: string; at: number }>();

  /**
   * eBay's public key for a notification signature (Notification API,
   * getPublicKey). Used to check that an account-deletion notice really came
   * from eBay before acting on it. Null if eBay isn't configured or the key
   * can't be fetched — the caller then refuses the notice.
   */
  async notificationPublicKey(kid: string, timeoutMs = 8000): Promise<string | null> {
    const cached = this.notificationKeys.get(kid);
    if (cached && Date.now() - cached.at < 3600_000) return cached.key;
    const creds = this.credentials();
    if (!creds || !/^[A-Za-z0-9_-]{1,128}$/.test(kid)) return null;
    try {
      const token = await this.accessToken(creds.id, creds.secret, creds.env);
      const res = await this.fetchImpl(`${HOSTS[creds.env]}/commerce/notification/v1/public_key/${kid}`, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { key?: string };
      if (!body.key) return null;
      this.notificationKeys.set(kid, { key: body.key, at: Date.now() });
      return body.key;
    } catch {
      return null;
    }
  }

  /**
   * For the verified-seller claim. Takes the item number eBay shows on the
   * listing page (the "legacy" id) and returns its seller and description.
   */
  async listingForProof(itemNumber: string, timeoutMs = 8000): Promise<ListingProof> {
    const creds = this.credentials();
    if (!creds) return { ok: false, error: "eBay isn't configured on this SigPath instance." };
    if (!/^\d{9,15}$/.test(itemNumber)) return { ok: false, error: "That isn't an eBay item number (the 12-digit number on the listing)." };
    try {
      const token = await this.accessToken(creds.id, creds.secret, creds.env);
      const res = await this.fetchImpl(
        `${HOSTS[creds.env]}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemNumber}`,
        {
          headers: { authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": creds.marketplace },
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (res.status === 404) return { ok: false, error: "eBay has no live listing with that item number." };
      if (!res.ok) return { ok: false, error: `eBay returned ${res.status}.` };
      const it = (await res.json()) as { seller?: { username?: string }; title?: string; shortDescription?: string; description?: string };
      if (!it.seller?.username) return { ok: false, error: "eBay didn't say who sells that listing." };
      return { ok: true, handle: it.seller.username, text: [it.title, it.shortDescription, it.description].filter(Boolean).join("\n") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "eBay couldn't be reached." };
    }
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
      const token = await this.accessToken(creds.id, creds.secret, creds.env);
      const url =
        `${HOSTS[creds.env]}/buy/browse/v1/item_summary/search` +
        `?q=${encodeURIComponent(query)}` +
        `&limit=${Math.min(Math.max(opts.limit ?? 20, EBAY_MIN_RESULTS), 200)}`;

      const res = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": creds.marketplace,
        },
        // Live prices: never a stored copy of an earlier search.
        cache: "no-store",
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
          condition: mapCondition(it.condition, it.conditionId),
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

      return {
        source: this.id,
        status: "ok",
        listings,
        // Sandbox returns eBay's own test inventory. Its prices are not real
        // market data, so a median computed over them means nothing — say so
        // rather than letting a demo quietly present test data as the market.
        detail:
          creds.env === "sandbox"
            ? "SANDBOX — eBay test inventory, not real listings. Prices are not market data."
            : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Never throws — see sources/types.ts. A rejected promise here would make
      // it far too easy for a caller to drop this source silently.
      return {
        source: this.id,
        status: /timeout|abort/i.test(msg) ? "timeout" : "error",
        listings: [],
        detail: msg.slice(0, 400),
      };
    }
  }
}
