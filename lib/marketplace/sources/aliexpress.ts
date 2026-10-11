/**
 * lib/marketplace/sources/aliexpress.ts — AliExpress, through its official
 * Affiliate API (AliExpress Open Platform, openservice.aliexpress.com).
 *
 * WHY ALIEXPRESS
 * It sells almost anything, ships to Europe and to Southeast Asia, and is where
 * buyers most need a second opinion. Its Affiliate API returns live prices in
 * the shopper's currency, with the tax for the ship-to country applied.
 *
 * WHY ITS PRICES STAY OUT OF THE MEDIAN
 * The same product costs far less on AliExpress than on eBay Germany, so pooled
 * into one median every AliExpress listing would be flagged "well below the
 * median", a false alarm on honest sellers. And comparing AliExpress only with
 * itself isn't a counterfeit check: a copy sold by many sellers at the same low
 * price looks normal next to the others. So, as Etsy did, this source declares
 * `priceComparable = false`: its listings are shown with their live prices and
 * a link to buy on AliExpress, marked "not price-checked", and never reach the
 * median, the best checked deals or SigPath's checkout.
 *
 * THE REQUEST (official docs, "HTTP request sample" and "Signature algorithm")
 * GET https://api-sg.aliexpress.com/sync with method, app_key, timestamp (ms),
 * sign_method=sha256 and the business parameters, plus `sign`: every parameter
 * sorted by name, each name followed by its value, concatenated, then
 * HMAC-SHA256 with the App Secret, in upper-case hex. Checked against both of
 * the docs' worked examples (tests/aliexpress.test.ts).
 *
 * THE RESPONSE
 * aliexpress_affiliate_product_query_response.resp_result: resp_code 200 means
 * success, and result.products.product holds the listings (field names as in
 * the widely used python-aliexpress-api client). A signature or key problem
 * comes back as error_response instead.
 */

import { createHmac } from "crypto";
import type { Listing, SearchOptions, SourceResult } from "../types";
import type { MarketplaceSource } from "./types";

const ENDPOINT = "https://api-sg.aliexpress.com/sync";
const METHOD = "aliexpress.affiliate.product.query";

/** target_currency values the API accepts (aliexpress.affiliate.product.query). */
const CURRENCIES = new Set(["USD", "GBP", "CAD", "EUR", "UAH", "MXN", "TRY", "RUB", "BRL", "AUD", "INR", "JPY", "IDR", "SEK", "KRW", "ILS", "THB", "CLP", "VND"]);

/** The signature: sorted name+value pairs, HMAC-SHA256 with the App Secret, upper-case hex. */
export function aliexpressSign(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .filter((k) => k !== "sign")
    .sort()
    .map((k) => k + params[k])
    .join("");
  return createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

/** "23.50" -> 2350. Null for anything that isn't a positive price. */
export function aliexpressPriceToMinorUnits(price?: string | number): number | null {
  const n = typeof price === "number" ? price : Number(String(price ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

interface AliProduct {
  product_id?: number | string;
  product_title?: string;
  product_detail_url?: string;
  promotion_link?: string;
  product_main_image_url?: string;
  target_sale_price?: string;
  target_sale_price_currency?: string;
  sale_price?: string;
  sale_price_currency?: string;
  shop_id?: number | string;
  shop_name?: string;
  first_level_category_id?: number | string;
  first_level_category_name?: string;
}

export class AliExpressSource implements MarketplaceSource {
  readonly id = "aliexpress" as const;
  /** A different price level from eBay Germany; see the header note. */
  readonly priceComparable = false;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The signed request URL for a search. */
  requestUrl(query: string, opts: SearchOptions = {}): string | null {
    const appKey = this.env.ALIEXPRESS_APP_KEY?.trim();
    const secret = this.env.ALIEXPRESS_APP_SECRET?.trim();
    if (!appKey || !secret) return null;
    const currency = (opts.currency ?? "EUR").toUpperCase();
    const params: Record<string, string> = {
      method: METHOD,
      app_key: appKey,
      timestamp: String(this.now()),
      sign_method: "sha256",
      keywords: query,
      page_size: String(Math.min(Math.max(opts.limit ?? 20, 1), 50)), // spec: 1..50
      target_currency: CURRENCIES.has(currency) ? currency : "EUR",
      target_language: "EN",
      ship_to_country: (this.env.ALIEXPRESS_SHIP_TO?.trim() || "DE").toUpperCase(),
    };
    const tracking = this.env.ALIEXPRESS_TRACKING_ID?.trim();
    if (tracking) params.tracking_id = tracking;
    params.sign = aliexpressSign(params, secret);
    return `${ENDPOINT}?${new URLSearchParams(params).toString()}`;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SourceResult> {
    const url = this.requestUrl(query, opts);
    if (!url) {
      return { source: this.id, status: "not_configured", listings: [], detail: "ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET are not set." };
    }
    try {
      const res = await this.fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
      if (res.status === 429) return { source: this.id, status: "rate_limited", listings: [], detail: "AliExpress returned 429." };
      if (!res.ok) return { source: this.id, status: "error", listings: [], detail: `AliExpress returned ${res.status}: ${(await res.text()).slice(0, 200)}` };

      const body = (await res.json()) as {
        error_response?: { code?: string; msg?: string };
        aliexpress_affiliate_product_query_response?: {
          resp_result?: { resp_code?: number; resp_msg?: string; result?: { products?: { product?: AliProduct[] } } };
        };
      };
      if (body.error_response) {
        const { code, msg } = body.error_response;
        const isLimit = /limit|frequency|flow/i.test(`${code} ${msg}`);
        return {
          source: this.id,
          status: isLimit ? "rate_limited" : "error",
          listings: [],
          detail: `AliExpress refused the request: ${code ?? "error"}${msg ? ` (${msg})` : ""}. Check ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET.`.slice(0, 400),
        };
      }
      const resp = body.aliexpress_affiliate_product_query_response?.resp_result;
      if (!resp || resp.resp_code !== 200) {
        return { source: this.id, status: "error", listings: [], detail: `AliExpress answered ${resp?.resp_code ?? "without a result"}: ${resp?.resp_msg ?? ""}`.slice(0, 400) };
      }

      const listings: Listing[] = [];
      for (const p of resp.result?.products?.product ?? []) {
        const amount = aliexpressPriceToMinorUnits(p.target_sale_price ?? p.sale_price);
        const currency = (p.target_sale_price_currency ?? p.sale_price_currency)?.toUpperCase();
        const link = p.promotion_link || p.product_detail_url;
        // Unpriceable or unlinkable products are dropped, not guessed at.
        if (amount === null || !currency || p.product_id === undefined || !link) continue;
        listings.push({
          id: String(p.product_id),
          source: this.id,
          title: p.product_title ?? "(untitled)",
          url: link,
          affiliate: !!p.promotion_link,
          price: { amount, currency },
          // Shipping depends on the buyer's address and isn't in the search
          // result; leaving it out is honest, and keeps the listing out of
          // SigPath's checkout, which needs a full total.
          condition: "new",
          imageUrl: p.product_main_image_url,
          category: p.first_level_category_id !== undefined ? { id: String(p.first_level_category_id), name: p.first_level_category_name ?? "" } : undefined,
          seller: { handle: `shop:${p.shop_id ?? "unknown"}`, displayName: p.shop_name },
        });
      }
      return {
        source: this.id,
        status: "ok",
        listings,
        detail: "Live AliExpress prices: shown, but kept out of the price comparison.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { source: this.id, status: /timeout|abort/i.test(msg) ? "timeout" : "error", listings: [], detail: msg.slice(0, 400) };
    }
  }
}
