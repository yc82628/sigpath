import { NextRequest, NextResponse } from "next/server";
import { limited, RULES } from "@/lib/guard/limit";
import { checkPrice, parsePrice, SHOPS } from "@/lib/marketplace/price-check";
import type { Money } from "@/lib/marketplace/types";
import { moneyText } from "@/lib/i18n/money";
import { translateCheck } from "@/lib/i18n/checks";
import { pickLang } from "@/lib/i18n/lang";
import { SeenStore } from "@/lib/extension/seen";
import { checkEbayListing, listingCheckDeps } from "@/lib/marketplace/listing-check";
import { listingKey } from "@/lib/marketplace/types";
import { count, type StatEvent } from "@/lib/stats/counter";
import { checkDiscount, referenceOf } from "@/lib/marketplace/discount";

/** What a check showed, as counted events (lib/stats/counter.ts): totals only, nothing about the product. */
function shown(verdict: string, deal: { tone: string } | null | undefined): StatEvent[] {
  return [...(verdict === "caution" ? ["caution" as const] : []), ...(verdict === "checked" && deal?.tone === "good" ? ["good-deal" as const] : [])];
}

// POST /api/extension/check
//   { from, title, price, url?, asin?, imageUrl?, share?, lang? }
//
// Extension 0.3.0 reads verdict, headline, points, typical, ebayOk, bestEbay
// and checkUrl; 0.4.0 also deal, market and elsewhere; 0.5.0 sends
//   { from: "ebay", itemId, lang } from an eBay listing page, and reads seller. Fields are only added,
// never renamed, while older versions are still installed.
//
// The SigPath extension (extension/) asking about the product page a shopper
// has open: the same check as /check, the answer shaped for its panel. With
// `share` on and an Amazon product, the price is also kept as a sighting
// (lib/extension/seen.ts): the product and its price, nothing about the
// shopper. Nothing else is stored or logged.

export const runtime = "nodejs";

const SITE = "https://sigpath.vercel.app";

/**
 * The panel's answer for an eBay listing, in the same shape as a shop's product
 * (fields only added): its verdict and every point, the deal score against the
 * same product in its condition, and a cheaper checked listing if there is one.
 */
async function ebayListingAnswer(itemId: string, lang: ReturnType<typeof pickLang>, userAgent: string | null) {
  if (!/^\d{9,15}$/.test(itemId)) return NextResponse.json({ error: "Send the eBay item number." }, { status: 400 });
  const r = await checkEbayListing(itemId, listingCheckDeps());
  await count(["ext-ebay", ...(r.ok ? shown(r.listing.check.verdict, r.deal) : [])], { userAgent });
  if (!r.ok) {
    const status = r.status === "not_found" ? 404 : r.status === "variations" ? 422 : 503;
    return NextResponse.json({ error: r.detail, reason: r.status }, { status, headers: { "Cache-Control": "no-store" } });
  }
  const tc = (t: string) => translateCheck(t, lang);
  const formatMoney = (x: Money) => moneyText(x, lang);
  const searchUrl = `${SITE}/search?q=${encodeURIComponent(r.query)}`;
  return NextResponse.json(
    {
      shop: "eBay",
      price: formatMoney(r.total),
      seller: r.listing.seller.displayName ?? r.listing.seller.handle,
      verdict: r.listing.check.verdict,
      headline: tc(r.listing.check.headline),
      points: r.listing.check.points.map((p) => ({ tone: p.tone, text: tc(p.text) })),
      typical: r.comparison
        ? {
            price: formatMoney({ amount: r.comparison.median, currency: r.total.currency }),
            listings: r.comparison.sampleSize,
            diffPct: Math.round(((r.total.amount - r.comparison.median) / r.comparison.median) * 100),
          }
        : null,
      deal: r.deal,
      market: r.market
        ? { low: formatMoney({ amount: r.market.low, currency: r.market.currency }), high: formatMoney({ amount: r.market.high, currency: r.market.currency }), listings: r.market.count, basis: r.market.basis }
        : null,
      elsewhere: null,
      ebayOk: r.ebay.status === "ok",
      // The panel's "best deal" line: here, only a cheaper checked listing of the same product and condition.
      bestEbay: r.cheaper
        ? [
            {
              title: r.cheaper.listing.title,
              url: r.cheaper.listing.url,
              price: formatMoney(r.cheaper.total),
              // Its own condition: refurbished shares the "new" group but isn't new.
              group: r.cheaper.listing.condition === "used" ? "used" : r.cheaper.listing.condition === "refurbished" ? "refurbished" : "new",
              affiliate: !!r.cheaper.listing.affiliate,
            },
          ]
        : [],
      // The full check: SigPath's search for the product, opened at this listing.
      checkUrl: `${searchUrl}#l-${encodeURIComponent(listingKey(r.listing))}`,
      searchUrl,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.extension);
  if (tooMany) return tooMany;

  const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  // An eBay listing page: only the item number is sent; the listing comes from eBay's API (listing-check.ts).
  if (b.from === "ebay") return ebayListingAnswer(str(b.itemId, 20), pickLang(typeof b.lang === "string" ? b.lang : undefined), req.headers.get("user-agent"));
  const title = str(b.title, 300);
  const priceText = str(b.price, 40);
  const from = (typeof b.from === "string" && b.from in SHOPS ? b.from : "other") as keyof typeof SHOPS;
  const url = /^https:\/\//.test(str(b.url, 500)) ? str(b.url, 500) : undefined;
  const lang = pickLang(typeof b.lang === "string" ? b.lang : undefined);
  const price = priceText ? parsePrice(priceText) : null;
  if (!title || !price) return NextResponse.json({ error: "Send the product's title and price." }, { status: 400 });

  const result = await checkPrice({ title, price, from, url });
  // The struck-out price the page shows, and its label ("UVP", "Was", "lowest in 30 days"), from 0.5.1 on (discount.ts).
  const was = parsePrice(str(b.was, 40));
  const lowest30 = parsePrice(str(b.lowest30, 40));
  const same = (m: Money | null) => (m && m.currency === price.currency ? m.amount : null);
  const discount = checkDiscount({
    price: price.amount,
    was: same(was),
    reference: referenceOf(str(b.wasLabel, 80)),
    lowest30: same(lowest30),
    market: result.market ? { typical: result.market.typical, high: result.market.high } : null,
    checked: result.product.check.verdict === "checked",
  });
  const misleading = discount?.verdict === "inflated" || discount?.verdict === "not-lower";
  await count(["ext-shop", ...shown(result.product.check.verdict, result.deal), ...(misleading ? (["inflated-discount"] as const) : [])], {
    userAgent: req.headers.get("user-agent"),
  });
  const tc = (t: string) => translateCheck(t, lang);
  const formatMoney = (x: Money) => moneyText(x, lang);

  if (from === "amazon" && b.share === true && typeof b.asin === "string") {
    await SeenStore.fromEnv()
      .record([{ asin: b.asin, title, price, imageUrl: b.imageUrl }])
      .catch(() => 0);
  }

  const c = result.comparison;
  const check = `${SITE}/check?${new URLSearchParams({ title, price: priceText, from, ...(url ? { url } : {}) })}`;
  return NextResponse.json(
    {
      shop: result.shop,
      price: formatMoney(result.product.price),
      verdict: result.product.check.verdict,
      headline: tc(result.product.check.headline),
      points: result.product.check.points.map((p) => ({ tone: p.tone, text: tc(p.text) })),
      typical: c
        ? {
            price: formatMoney({ amount: c.median, currency: result.product.price.currency }),
            listings: c.sampleSize,
            diffPct: Math.round(((result.product.price.amount - c.median) / c.median) * 100),
          }
        : null,
      // The deal score, as on the search page: -22 is 22% under the typical price.
      deal: result.deal,
      market: result.market
        ? { low: formatMoney({ amount: result.market.low, currency: result.market.currency }), high: formatMoney({ amount: result.market.high, currency: result.market.currency }), listings: result.market.count, basis: result.market.basis }
        : null,
      // The advertised discount against the market and the 30-day low (discount.ts); null without a struck-out price.
      discount: discount
        ? {
            verdict: discount.verdict,
            claimedPct: discount.claimedPct,
            vsMarketPct: discount.vsMarketPct,
            reference: discount.reference,
            was: formatMoney({ amount: discount.was, currency: price.currency }),
            lowest30: discount.lowest30 !== null ? formatMoney({ amount: discount.lowest30, currency: price.currency }) : null,
            typical: discount.typical !== null ? formatMoney({ amount: discount.typical, currency: price.currency }) : null,
          }
        : null,
      // A believable AliExpress offer for the same product: shown, never checked.
      elsewhere: result.elsewhere
        ? { shop: "AliExpress", title: result.elsewhere.listing.title, url: result.elsewhere.listing.url, price: formatMoney(result.elsewhere.total), affiliate: !!result.elsewhere.listing.affiliate }
        : null,
      ebayOk: result.ebay.status === "ok",
      bestEbay: result.bestEbay
        .slice(0, 2)
        .map((d) => ({ title: d.listing.title, url: d.listing.url, price: formatMoney(d.total), group: d.group, affiliate: !!d.listing.affiliate })),
      checkUrl: check,
      searchUrl: `${SITE}/search?q=${encodeURIComponent(result.query)}`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
