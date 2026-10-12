import { test } from "node:test";
import assert from "node:assert";
import { addItem, canPayNow, CART_MAX_ITEMS, CART_TTL_MS, parseCart, priceMoved, prune, removeItem, totals, type CartItem } from "../lib/cart/cart";
import { refreshPrices } from "../lib/cart/refresh";
import { EbaySource } from "../lib/marketplace/sources/ebay";

const item = (n: number, over: Partial<CartItem> = {}): CartItem => ({
  key: `ebay:v1|10000000000${n}|0`,
  source: "ebay",
  id: `v1|10000000000${n}|0`,
  title: `Apple AirPods Pro 2 #${n}`,
  url: `https://www.ebay.de/itm/10000000000${n}`,
  condition: "new",
  seller: "seller",
  price: { amount: 20000, currency: "EUR" },
  shipping: { amount: 500, currency: "EUR" },
  verdict: "checked",
  headline: "SigPath-checked",
  addedAt: 1_000_000,
  ...over,
});

test("the cart reads back only well-formed items, and never throws on what's in storage", () => {
  assert.deepEqual(parseCart(null), []);
  assert.deepEqual(parseCart("not json"), []);
  assert.deepEqual(parseCart('{"a":1}'), []);
  const good = item(1);
  const raw = JSON.stringify([
    good,
    good, // a duplicate
    { ...item(2), url: "javascript:alert(1)" }, // not an https link
    { ...item(3), key: "ebay:something-else" }, // key doesn't match source and id
    { ...item(4), price: { amount: -5, currency: "EUR" } },
    { ...item(5), verdict: "trusted" },
    null,
  ]);
  assert.deepEqual(parseCart(raw), [good]);
});

test("adding, removing, the size cap and the 30-day expiry", () => {
  let cart: CartItem[] = [];
  for (let i = 0; i < CART_MAX_ITEMS; i++) {
    const r = addItem(cart, item(i));
    assert.ok(r.ok);
    cart = r.cart;
  }
  assert.equal(addItem(cart, item(0)).ok, true, "adding what's already there is a no-op, not an error");
  const full = addItem(cart, item(99));
  assert.equal(full.ok, false);
  assert.match(!full.ok ? full.reason : "", /up to 30 items/);
  assert.equal(removeItem(cart, item(0).key).length, CART_MAX_ITEMS - 1);
  assert.deepEqual(prune([item(1, { addedAt: 0 }), item(2, { addedAt: CART_TTL_MS })], CART_TTL_MS + 1).map((c) => c.addedAt), [CART_TTL_MS]);
});

test("totals use today's price where known, skip what's gone, and keep currencies apart", () => {
  const cart = [item(1), item(2), item(3, { price: { amount: 1000, currency: "USD" }, shipping: undefined }), item(4)];
  const t = totals(cart, {
    [item(1).key]: { status: "ok", price: { amount: 18000, currency: "EUR" }, shipping: { amount: 0, currency: "EUR" } },
    [item(4).key]: { status: "gone" },
  });
  assert.deepEqual(t, [
    { amount: 18000 + 20500, currency: "EUR" },
    { amount: 1000, currency: "USD" },
  ]);
});

test("Pay with USDC only while the quote is valid and the price hasn't moved", () => {
  const quoted = item(1, { quote: { token: "t", usdc: "230.00 USDC", expiresAt: 5000 } });
  const same = { status: "ok" as const, price: { amount: 20000, currency: "EUR" }, shipping: { amount: 500, currency: "EUR" } };
  assert.equal(canPayNow(quoted, same, 4000), true);
  assert.equal(canPayNow(quoted, undefined, 4000), true, "not checked yet: the signed quote still holds");
  assert.equal(canPayNow(quoted, same, 5000), false, "quote expired");
  const cheaper = { ...same, price: { amount: 19000, currency: "EUR" } };
  assert.equal(priceMoved(quoted, cheaper), true);
  assert.equal(canPayNow(quoted, cheaper, 4000), false, "a changed price needs a fresh check and a fresh quote");
  assert.equal(canPayNow(quoted, { status: "gone" }, 4000), false);
  assert.equal(canPayNow(quoted, { ...same, status: "sold_out" }, 4000), false);
  assert.equal(canPayNow(item(2), same, 4000), false, "never offered without a quote");
});

test("refreshing asks eBay item by item, within the budget; demo and other marketplaces are never guessed", async () => {
  const asked: string[] = [];
  const ebay = {
    currentPrice: async (id: string) => {
      asked.push(id);
      if (id.includes("404")) return { status: "gone" as const };
      return { status: "ok" as const, price: { amount: 19900, currency: "EUR" } };
    },
  };
  let budget = 2;
  const r = await refreshPrices(
    [
      { source: "ebay", id: "v1|111111111111|0" },
      { source: "ebay", id: "v1|404404404404|0" },
      { source: "ebay", id: "v1|333333333333|0" },
      { source: "stub", id: "demo-1" },
      { source: "aliexpress", id: "123" },
    ],
    ebay,
    async () => budget-- > 0,
  );
  assert.equal(asked.length, 2, "the third eBay item is past the budget");
  assert.equal(Object.values(r).filter((f) => f.status === "unchecked").length, 3);
  assert.match((r["stub:demo-1"] as { reason: string }).reason, /demo/i);
  assert.match((r["aliexpress:123"] as { reason: string }).reason, /can't check/);
});

test("eBay's current price: price, shipping, sold out and ended, from Browse getItem", async () => {
  const env = { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret", EBAY_ENV: "production" };
  const reply = (status: number, body: unknown): typeof fetch =>
    (async (url: string | URL | Request) => {
      if (String(url).includes("oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 });
      assert.match(String(url), /\/buy\/browse\/v1\/item\/v1%7C123456789012%7C0$/);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  const ok = await new EbaySource(env, reply(200, { price: { value: "199.00", currency: "EUR" }, shippingOptions: [{ shippingCost: { value: "4.99", currency: "EUR" } }] })).currentPrice("v1|123456789012|0");
  assert.deepEqual(ok, { status: "ok", price: { amount: 19900, currency: "EUR" }, shipping: { amount: 499, currency: "EUR" } });
  const sold = await new EbaySource(env, reply(200, { price: { value: "199.00", currency: "EUR" }, estimatedAvailabilities: [{ estimatedAvailabilityStatus: "OUT_OF_STOCK" }] })).currentPrice("v1|123456789012|0");
  assert.equal(sold.status, "sold_out");
  assert.equal((await new EbaySource(env, reply(404, {})).currentPrice("v1|123456789012|0")).status, "gone");
  assert.equal((await new EbaySource(env, reply(200, {})).currentPrice("not-an-id")).status, "error");
  assert.equal((await new EbaySource({}).currentPrice("v1|123456789012|0")).status, "not_configured");
});
