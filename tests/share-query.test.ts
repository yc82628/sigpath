import { test } from "node:test";
import assert from "node:assert";
import { queryFromShare } from "../lib/marketplace/share-query";

/**
 * What a shopping app shares with SigPath, as a product to search for
 * (lib/marketplace/share-query.ts). The shared link is never opened.
 */

test("the Amazon app: the title in the text, a short link without a name", () => {
  const q = queryFromShare({ text: "Sony WF-1000XM5 Premium True Wireless In-Ear Headphones with Noise Cancelling https://amzn.eu/d/3xYzAbC" });
  assert.ok(q);
  assert.match(q!.query, /^Sony WF-1000XM5/);
  assert.ok(!q!.query.includes("amzn"), "the link isn't searched for");
  assert.equal(q!.shop, "Amazon");
});

test("the eBay app: its own phrase around the title, in German and English", () => {
  const de = queryFromShare({ text: "Schau dir diesen Artikel auf eBay an: Sony WH-1000XM5 Kopfhörer Schwarz https://ebay.us/m/AbCdEf" });
  assert.match(de!.query, /^Sony WH-1000XM5/);
  assert.ok(!/schau|ebay|artikel/i.test(de!.query), de!.query);
  assert.equal(de!.shop, "eBay");
  const en = queryFromShare({ text: "Check out this item on eBay: Apple iPhone 15 128GB Blau https://ebay.us/m/XyZ" });
  assert.match(en!.query, /^Apple iPhone 15 128GB/, "a shared product keeps its storage, like a pasted link");
});

test("a shop's page shared from Chrome: the name in the link wins over the page title", () => {
  const q = queryFromShare({
    title: "Apple AirPods Pro 2 : Amazon.de: Elektronik & Foto",
    url: "https://www.amazon.de/Apple-AirPods-Pro-2-Generation/dp/B0CHWRXH8B/ref=sr_1_1",
  });
  assert.match(q!.query, /AirPods Pro 2/);
  assert.equal(q!.asin, "B0CHWRXH8B");
  // A title alone: the shop's suffix goes.
  const t = queryFromShare({ title: "Nintendo Switch OLED Weiß : Amazon.de: Games" });
  assert.match(t!.query, /^Nintendo Switch OLED/);
  assert.ok(!/amazon/i.test(t!.query));
});

test("nothing usable shared: no search", () => {
  assert.equal(queryFromShare({ text: "https://amzn.eu/d/3xYzAbC" }), null, "a short link alone names nothing");
  assert.equal(queryFromShare({}), null);
  assert.equal(queryFromShare({ text: "  :  " }), null);
});
