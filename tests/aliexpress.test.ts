import { test } from "node:test";
import assert from "node:assert";
import { AliExpressSource, aliexpressPriceToMinorUnits, aliexpressSign } from "../lib/marketplace/sources/aliexpress";
import { analyse } from "../lib/marketplace/anomaly";
import { labelSearch } from "../lib/marketplace/label";
import { checkoutEligibility, priceCheckFor } from "../lib/checkout/eligibility";
import { withoutSiteOnly } from "../lib/marketplace/site-only";
import type { LabelledSearch } from "../lib/marketplace/labelled-search";
import type { Listing, SourceResult } from "../lib/marketplace/types";

const KEYS = { ALIEXPRESS_APP_KEY: "123456", ALIEXPRESS_APP_SECRET: "helloworld" };

test("the signature matches both worked examples in AliExpress's own docs", () => {
  // "HTTP request sample", case 1 (business interface).
  assert.equal(
    aliexpressSign(
      { access_token: "test", aliexpress_category_id: "200135143", app_key: "123456", method: "aliexpress.logistics.redefining.getonlinelogisticsinfo", sign_method: "sha256", timestamp: "1517820392000" },
      "helloworld",
    ),
    "F7F7926B67316C9D1E8E15F7E66940ED3059B1638C497D77973F30046EFB5BBB",
  );
  // Case 2 (system interface) signs the API path in front; the same HMAC over that string.
  const { createHmac } = require("crypto") as typeof import("crypto");
  assert.equal(
    createHmac("sha256", "helloworld").update("/auth/token/createapp_key12345678code3_500102_JxZ05Ux3cnnSSUm6dCxYg6Q26sign_methodsha256timestamp1517820392000").digest("hex").toUpperCase(),
    "35607762342831B6A417A0DED84B79C05FEFBF116969C48AD6DC00279A9F4D81",
  );
});

test("prices: '23.50' is 2350 minor units; anything that isn't a price is dropped", () => {
  assert.equal(aliexpressPriceToMinorUnits("23.50"), 2350);
  assert.equal(aliexpressPriceToMinorUnits("0.99"), 99);
  assert.equal(aliexpressPriceToMinorUnits(""), null);
  assert.equal(aliexpressPriceToMinorUnits("0"), null);
  assert.equal(aliexpressPriceToMinorUnits("abc"), null);
});

test("without both keys it isn't searched, and says so", async () => {
  const r = await new AliExpressSource({ ALIEXPRESS_APP_KEY: "x" }).search("mug");
  assert.equal(r.status, "not_configured");
});

test("a search is a signed request for live EUR prices shipped to Germany, and the answer becomes listings", async () => {
  let asked = "";
  const fetchImpl = (async (url: string) => {
    asked = url;
    return new Response(
      JSON.stringify({
        aliexpress_affiliate_product_query_response: {
          resp_result: {
            resp_code: 200,
            resp_msg: "Call succeeds",
            result: {
              products: {
                product: [
                  { product_id: 1005001, product_title: "Wireless earbuds", product_detail_url: "https://www.aliexpress.com/item/1005001.html", promotion_link: "https://s.click.aliexpress.com/e/_abc", product_main_image_url: "https://ae01.alicdn.com/a.jpg", target_sale_price: "23.50", target_sale_price_currency: "EUR", shop_id: 42 },
                  { product_id: 1005002, product_title: "No price", product_detail_url: "https://www.aliexpress.com/item/1005002.html", target_sale_price: "" },
                ],
              },
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const src = new AliExpressSource({ ...KEYS, ALIEXPRESS_TRACKING_ID: "sigpath" }, fetchImpl, () => 1517820392000);
  const r = await src.search("earbuds", { limit: 20 });

  const params = Object.fromEntries(new URL(asked).searchParams);
  assert.equal(new URL(asked).origin + new URL(asked).pathname, "https://api-sg.aliexpress.com/sync");
  assert.equal(params.method, "aliexpress.affiliate.product.query");
  assert.equal(params.target_currency, "EUR");
  assert.equal(params.ship_to_country, "DE");
  assert.equal(params.tracking_id, "sigpath");
  const { sign, ...rest } = params;
  assert.equal(sign, aliexpressSign(rest, "helloworld"), "the request carries a valid signature");

  assert.equal(r.status, "ok");
  assert.equal(r.listings.length, 1, "the unpriced product is dropped, not guessed at");
  const [l] = r.listings;
  assert.deepEqual(l.price, { amount: 2350, currency: "EUR" });
  assert.equal(l.url, "https://s.click.aliexpress.com/e/_abc");
  assert.equal(l.affiliate, true);
  assert.equal(l.shipping, undefined, "shipping isn't in the search result, so none is invented");
  assert.equal(l.seller.handle, "shop:42");
});

test("a refused key comes back as an error the page can show, never as an empty success", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error_response: { code: "IncompleteSignature", msg: "The request signature does not conform to platform standards" } }), { status: 200 })) as unknown as typeof fetch;
  const r = await new AliExpressSource(KEYS, fetchImpl).search("mug");
  assert.equal(r.status, "error");
  assert.match(r.detail ?? "", /IncompleteSignature/);
});

// --- how AliExpress listings are treated --------------------------------------------

const ebay = (id: string, amount: number): Listing => ({
  id, source: "ebay", title: "Wireless earbuds Pro", url: `https://ebay.de/${id}`, condition: "new",
  price: { amount, currency: "EUR" }, shipping: { amount: 0, currency: "EUR" }, seller: { handle: `s${id}` },
});
const ali = (id: string, amount: number): Listing => ({
  id, source: "aliexpress", title: "Wireless earbuds Pro", url: `https://s.click.aliexpress.com/${id}`, affiliate: true, condition: "new",
  price: { amount, currency: "EUR" }, seller: { handle: `shop:${id}` },
});

test("AliExpress prices are shown but never flagged, compared, promoted or checked out", () => {
  const results: SourceResult[] = [
    { source: "ebay", status: "ok", listings: [1, 2, 3, 4, 5, 6].map((i) => ebay(`e${i}`, 10000 + i * 100)) },
    // As the search attaches it (search.ts) from the source's own declaration.
    { source: "aliexpress", status: "ok", comparable: new AliExpressSource({}).priceComparable, listings: [ali("a1", 1900), ali("a2", 2100)] },
  ];
  assert.equal(results[1].comparable, false);
  const a = analyse(results, { query: "Wireless earbuds Pro" });
  const { flagsOf, labelOf, deals } = labelSearch({ listings: results.flatMap((r) => r.listings), analysis: a });
  const cheap = results[1].listings[0];

  assert.deepEqual(flagsOf(cheap), [], "a fifth of eBay's price is not called a scam");
  assert.equal(labelOf(cheap).verdict, "unchecked");
  assert.match((priceCheckFor(cheap, a) as { reason: string }).reason, /AliExpress prices aren't compared with eBay's/);
  assert.ok(deals.every((d) => d.listing.source === "ebay"), "never a best checked deal");
  const elig = checkoutEligibility(cheap, [], { checked: true });
  assert.equal(elig.eligible, false);
  assert.match(!elig.eligible ? elig.reason : "", /bought on AliExpress/);
});

test("AliExpress listings stay on SigPath's own pages: not in the paid API or sent to the AI model", () => {
  const result = {
    listings: [{ source: "ebay", id: "1" }, { source: "aliexpress", id: "2" }],
    sources: [{ source: "ebay", status: "ok" }, { source: "aliexpress", status: "ok" }],
    bestCheckedDeals: [{ listing: "ebay:1" }],
  } as unknown as LabelledSearch;
  const out = withoutSiteOnly(result);
  assert.deepEqual(out.listings.map((l) => l.source), ["ebay"]);
  assert.deepEqual(out.sources.map((s) => s.source), ["ebay"]);
});
