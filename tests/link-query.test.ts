import { test } from "node:test";
import assert from "node:assert";
import { looksLikeLink, queryFromLink } from "../lib/marketplace/link-query";

/** A pasted product link becomes a search for the product named in it, without fetching the shop's page. */

test("the product name in an Amazon link, and its ASIN", () => {
  const r = queryFromLink("https://www.amazon.de/Apple-AirPods-Pro-2-Generation/dp/B0CHWRXH8B/ref=sr_1_1?keywords=airpods&qid=1");
  assert.deepEqual(r, { query: "Apple AirPods Pro 2 Generation", shop: "Amazon", asin: "B0CHWRXH8B" });
});

test("OTTO, MediaMarkt and Saturn links", () => {
  assert.equal(queryFromLink("https://www.otto.de/p/apple-iphone-15-128gb-schwarz-1834567890/#variationId=1834567891")?.query, "apple iphone 15 128gb schwarz");
  assert.equal(queryFromLink("https://www.mediamarkt.de/de/product/_sony-wh-1000xm5-kopfhorer-2817466.html")?.query, "sony wh 1000xm5");
  assert.equal(queryFromLink("https://www.saturn.de/de/product/_nintendo-switch-oled-modell-2766455.html")?.shop, "Saturn");
});

test("a link with no name in it can't be read", () => {
  assert.equal(queryFromLink("https://www.aliexpress.com/item/1005006123456789.html"), null);
  assert.equal(queryFromLink("https://www.amazon.de/dp/B0CHWRXH8B"), null);
  assert.equal(queryFromLink("not a link at all"), null);
});

test("only links count as links", () => {
  assert.ok(looksLikeLink("https://www.amazon.de/x/dp/B0CHWRXH8B"));
  assert.ok(looksLikeLink("www.otto.de/p/x"));
  assert.ok(!looksLikeLink("AirPods Pro"));
});
