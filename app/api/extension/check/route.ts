import { NextRequest, NextResponse } from "next/server";
import { limited, RULES } from "@/lib/guard/limit";
import { checkPrice, parsePrice, SHOPS } from "@/lib/marketplace/price-check";
import { formatMoney } from "@/lib/marketplace/types";
import { translateCheck } from "@/lib/i18n/checks";
import { pickLang } from "@/lib/i18n/lang";
import { SeenStore } from "@/lib/extension/seen";

// POST /api/extension/check
//   { from, title, price, url?, asin?, imageUrl?, share?, lang? }
//
// The SigPath extension (extension/) asking about the product page a shopper
// has open: the same check as /check, the answer shaped for its panel. With
// `share` on and an Amazon product, the price is also kept as a sighting
// (lib/extension/seen.ts): the product and its price, nothing about the
// shopper. Nothing else is stored or logged.

export const runtime = "nodejs";

const SITE = "https://sigpath.vercel.app";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.extension);
  if (tooMany) return tooMany;

  const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const title = str(b.title, 300);
  const priceText = str(b.price, 40);
  const from = (typeof b.from === "string" && b.from in SHOPS ? b.from : "other") as keyof typeof SHOPS;
  const url = /^https:\/\//.test(str(b.url, 500)) ? str(b.url, 500) : undefined;
  const lang = pickLang(typeof b.lang === "string" ? b.lang : undefined);
  const price = priceText ? parsePrice(priceText) : null;
  if (!title || !price) return NextResponse.json({ error: "Send the product's title and price." }, { status: 400 });

  const result = await checkPrice({ title, price, from, url });
  const tc = (t: string) => translateCheck(t, lang);

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
      ebayOk: result.ebay.status === "ok",
      bestEbay: result.bestEbay.slice(0, 2).map((d) => ({ title: d.listing.title, url: d.listing.url, price: formatMoney(d.total), group: d.group })),
      checkUrl: check,
      searchUrl: `${SITE}/search?q=${encodeURIComponent(result.query)}`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
