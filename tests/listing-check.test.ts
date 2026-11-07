import { test } from "node:test";
import assert from "node:assert";
import { checkEbayListing, type ListingCheckDeps } from "../lib/marketplace/listing-check";
import { EbaySource } from "../lib/marketplace/sources/ebay";
import type { MarketplaceSource } from "../lib/marketplace/sources/types";
import type { Listing } from "../lib/marketplace/types";

/**
 * The extension on an eBay listing page: the listing comes from eBay's API by
 * its item number, and is judged as the search judges it, against the other
 * listings of the same product.
 */

const at = (id: string, euros: number, over: Partial<Listing> = {}): Listing => ({
  id: `v1|${id}|0`,
  source: "ebay",
  title: "Nintendo Switch OLED Konsole",
  url: `https://www.ebay.de/itm/${id}`,
  price: { amount: euros * 100, currency: "EUR" },
  shipping: { amount: 0, currency: "EUR" },
  condition: "new",
  seller: { handle: `seller${id}`, feedbackScore: 250 },
  ...over,
});

const market = [210, 205, 200, 200, 195, 190, 220].map((p, i) => at(String(100000000 + i), p));

function deps(page: Listing, results: Listing[] = market, status: "ok" | "error" = "ok"): ListingCheckDeps & { searched: string[] } {
  const searched: string[] = [];
  const ebay: MarketplaceSource = { id: "ebay", search: async (q) => (searched.push(q), { source: "ebay", status, listings: status === "ok" ? results : [] }) };
  return { lookup: async () => ({ status: "ok", listing: page }), sources: [ebay], searched };
}

test("a fair eBay listing: checked, scored against the others, and a cheaper checked one offered", async () => {
  const page = at("123456789012", 202, { title: "Nintendo Switch OLED Konsole Weiß, neu & OVP" });
  const d = deps(page);
  const r = await checkEbayListing("123456789012", d);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(d.searched, ["Nintendo Switch OLED"], "searched by its own title, cut to the model");
  assert.strictEqual(r.listing.id, page.id, "the listing itself, added to the results");
  assert.strictEqual(r.listing.check.verdict, "checked");
  assert.strictEqual(r.market?.typical, 20000, "the other seven, without itself");
  assert.deepStrictEqual(r.deal, { pct: 1, tone: "fair" });
  assert.strictEqual(r.cheaper?.total.amount, 19000, "the cheapest other checked one, cheaper than this");
});

test("the cheapest listing gets no 'cheaper' offer, and isn't counted twice when eBay's search already has it", async () => {
  const page = at("123456789013", 185);
  const r = await checkEbayListing("123456789013", deps(page, [...market, page]));
  assert.ok(r.ok);
  assert.strictEqual(r.cheaper, null);
  assert.strictEqual(r.market?.count, 7, "itself left out of its own market");
  assert.ok(r.deal && r.deal.tone === "fair");
});

test("bait on eBay: caution, the warning said, and never a deal score", async () => {
  const page = at("123456789014", 79);
  const r = await checkEbayListing("123456789014", deps(page));
  assert.ok(r.ok);
  assert.strictEqual(r.listing.check.verdict, "caution");
  assert.ok(r.listing.check.points.some((p) => p.tone === "warn"), "the reason is shown");
  assert.strictEqual(r.deal, null, "a flagged −60% is bait, not a deal");
});

test("a used listing is measured against used ones", async () => {
  const used = [140, 150, 150, 155, 160, 170].map((p, i) => at(String(200000000 + i), p, { condition: "used" }));
  const page = at("123456789015", 150, { condition: "used" });
  const r = await checkEbayListing("123456789015", deps(page, [...market, ...used]));
  assert.ok(r.ok);
  assert.strictEqual(r.market?.basis, "used");
  assert.strictEqual(r.market?.typical, 15250, "the median of the six other used ones");
  assert.strictEqual(r.cheaper?.total.amount, 14000, "a cheaper USED one, not a new one");
});

test("a refurbished listing is measured against new and refurbished together, never new alone", async () => {
  const refurbs = [150, 155, 160].map((p, i) => at(String(300000000 + i), p, { condition: "refurbished" }));
  const page = at("123456789018", 160, { condition: "refurbished" });
  const r = await checkEbayListing("123456789018", deps(page, [...market, ...refurbs]));
  assert.ok(r.ok);
  assert.strictEqual(r.market?.basis, "new-refurbished");
  assert.strictEqual(r.market?.typical, 19750, "the seven new and three refurbished others");
  assert.ok(r.deal && r.deal.pct === -19, "not the −20 % it would read against new ones alone");
});

test("no listing to check: said why, nothing searched", async () => {
  const d: ListingCheckDeps = {
    lookup: async () => ({ status: "variations", detail: "several variations" }),
    sources: [{ id: "ebay", search: async () => assert.fail("nothing to search for") }],
  };
  assert.deepStrictEqual(await checkEbayListing("123456789016", d), { ok: false, status: "variations", detail: "several variations" });
  const down = await checkEbayListing("123456789017", deps(at("123456789017", 200), market, "error"));
  assert.ok(!down.ok || down.listing.check.verdict !== "checked", "eBay's search down: no verdict pretends otherwise");
});

test("eBay's single-item answer is read like a search result, and a listing with variations is said so", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
    if (String(url).includes("legacy_item_id=111111111111")) {
      return new Response(JSON.stringify({ errors: [{ errorId: 11006, message: "The legacy Id is invalid. The item has variations." }] }), { status: 400 });
    }
    return new Response(
      JSON.stringify({
        itemId: "v1|123456789012|0",
        title: "Nintendo Switch OLED",
        itemWebUrl: "https://www.ebay.de/itm/123456789012",
        price: { value: "199.00", currency: "EUR" },
        shippingOptions: [{ shippingCost: { value: "4.99", currency: "EUR" } }],
        conditionId: "3000",
        categoryId: "139971",
        categoryPath: "Konsolen & Spiele|Konsolen",
        seller: { username: "shop_one", feedbackScore: 812, feedbackPercentage: "99.6" },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const ebay = new EbaySource({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "s" }, fetchImpl);
  const ok = await ebay.listingByItemNumber("123456789012");
  assert.ok(ok.status === "ok");
  assert.deepStrictEqual(
    [ok.listing.id, ok.listing.condition, ok.listing.price.amount, ok.listing.shipping?.amount, ok.listing.category, ok.listing.seller],
    ["v1|123456789012|0", "used", 19900, 499, { id: "139971", name: "Konsolen" }, { handle: "shop_one", feedbackScore: 812, feedbackPercentage: 99.6 }],
  );
  assert.strictEqual((await ebay.listingByItemNumber("111111111111")).status, "variations");
  assert.strictEqual((await ebay.listingByItemNumber("not-a-number")).status, "not_found");
  assert.strictEqual((await new EbaySource({}).listingByItemNumber("123456789012")).status, "not_configured");
});
