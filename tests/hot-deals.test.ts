import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { hotDeals, resetHotDealsMemory, HOT_TTL_SECONDS, type HotProduct } from "../lib/hot/hot-deals";
import { AliExpressSource } from "../lib/marketplace/sources/aliexpress";
import type { Kv } from "../lib/kv/upstash";

/**
 * "Selling fast on AliExpress": only what AliExpress reports, with a real order
 * count, and one request an hour for the whole site however many people visit.
 */

const KEYS = { ALIEXPRESS_APP_KEY: "k", ALIEXPRESS_APP_SECRET: "s" };
const product = (id: number, sold: unknown, extra: Record<string, unknown> = {}) => ({
  product_id: id,
  product_title: `Product ${id}`,
  product_detail_url: `https://www.aliexpress.com/item/${id}.html`,
  promotion_link: `https://s.click.aliexpress.com/e/${id}`,
  product_main_image_url: `https://ae01.alicdn.com/${id}.jpg`,
  target_sale_price: "12.34",
  target_sale_price_currency: "EUR",
  lastest_volume: sold,
  ...extra,
});
const answer = (products: unknown[]) =>
  (async () =>
    new Response(JSON.stringify({ aliexpress_affiliate_hotproduct_query_response: { resp_result: { resp_code: 200, result: { products: { product: products } } } } }), {
      status: 200,
    })) as unknown as typeof fetch;

function memoryKv() {
  const store = new Map<string, string>();
  const kv: Kv = {
    async command<T>(args: (string | number)[]) {
      if (args[0] === "GET") return (store.get(String(args[1])) ?? null) as T;
      if (args[0] === "SET") store.set(String(args[1]), String(args[2]));
      return "OK" as T;
    },
    async pipeline() {
      return [];
    },
  };
  return kv;
}

beforeEach(resetHotDealsMemory);

test("the hot-products request is signed and sorted by orders", () => {
  const url = new URL(new AliExpressSource(KEYS, fetch, () => 1).hotProductsUrl(20)!);
  assert.equal(url.searchParams.get("method"), "aliexpress.affiliate.hotproduct.query");
  assert.equal(url.searchParams.get("sort"), "LAST_VOLUME_DESC");
  assert.match(url.searchParams.get("sign")!, /^[0-9A-F]{64}$/);
  assert.equal(new AliExpressSource({}).hotProductsUrl(), null, "no keys, no request");
});

test("most orders first; nothing shown without a price, a product page or a real order count", async () => {
  const src = new AliExpressSource(
    KEYS,
    answer([
      product(1, 120),
      product(2, "4300"),
      product(3, 0),
      product(4, undefined),
      product(5, 900, { target_sale_price: undefined, sale_price: undefined }),
      product(6, 800, { product_detail_url: "http://insecure.example/6" }),
      product(7, 50),
    ]),
  );
  const hot = await src.hotProducts();
  assert.deepEqual(hot.map((h) => [h.id, h.sold]), [["2", 4300], ["1", 120], ["7", 50]]);
  assert.deepEqual(hot[0].price, { amount: 1234, currency: "EUR" });
  assert.equal(hot[0].url, "https://www.aliexpress.com/item/2.html", "the product page, not the affiliate link");
});

test("no keys, no hot products, and no request", async () => {
  let asked = false;
  const src = new AliExpressSource({}, (async () => ((asked = true), new Response("{}"))) as unknown as typeof fetch);
  assert.deepEqual(await src.hotProducts(), []);
  assert.equal(asked, false);
});

test("asked once an hour, whoever visits; again after the hour", async () => {
  const kv = memoryKv();
  let asks = 0;
  const hot: HotProduct[] = [{ id: "1", title: "A", url: "https://www.aliexpress.com/item/1.html", price: { amount: 999, currency: "EUR" }, sold: 10 }];
  let now = 1_000_000;
  const opts = { fetch: async () => (asks++, hot), kv, now: () => now };
  const first = await hotDeals(opts);
  assert.equal(asks, 1);
  resetHotDealsMemory(); // another instance: the shared database answers
  now += (HOT_TTL_SECONDS - 60) * 1000;
  assert.deepEqual(await hotDeals(opts), first);
  assert.equal(asks, 1);
  now += 120 * 1000;
  resetHotDealsMemory();
  await hotDeals(opts);
  assert.equal(asks, 2);
});

test("an outage shows nothing, and is asked again after five minutes, not an hour", async () => {
  const kv = memoryKv();
  let asks = 0;
  let now = 5_000_000;
  const opts = { fetch: async (): Promise<HotProduct[]> => { asks++; throw new Error("down"); }, kv, now: () => now };
  assert.deepEqual((await hotDeals(opts)).deals, []);
  now += 4 * 60 * 1000;
  await hotDeals(opts);
  assert.equal(asks, 1);
  now += 2 * 60 * 1000;
  await hotDeals(opts);
  assert.equal(asks, 2);
});
