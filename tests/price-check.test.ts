import { test } from "node:test";
import assert from "node:assert";
import { checkPrice, parsePrice, shortQuery } from "../lib/marketplace/price-check";
import type { MarketplaceSource } from "../lib/marketplace/sources/types";
import type { Listing } from "../lib/marketplace/types";

test("prices as shops print them", () => {
  assert.deepEqual(parsePrice("249,00 €"), { amount: 24900, currency: "EUR" }, "Amazon.de");
  assert.deepEqual(parsePrice("1.249,00 €"), { amount: 124900, currency: "EUR" });
  assert.deepEqual(parsePrice("€1,249.00"), { amount: 124900, currency: "EUR" });
  assert.deepEqual(parsePrice("US $23.50"), { amount: 2350, currency: "USD" });
  assert.deepEqual(parsePrice("RM 99"), { amount: 9900, currency: "MYR" });
  assert.deepEqual(parsePrice("23.5 EUR"), { amount: 2350, currency: "EUR" }, "JSON-LD price plus currency");
  assert.deepEqual(parsePrice("249"), { amount: 24900, currency: "EUR" });
  assert.equal(parsePrice("free"), null);
  assert.equal(parsePrice("0,00 €"), null);
});

test("a long shop title becomes a short eBay search", () => {
  assert.equal(shortQuery("Apple AirPods Pro (2nd generation) Wireless Earbuds, Up to 2x More Noise Cancelling"), "Apple AirPods Pro");
  assert.equal(shortQuery("Apple AirPods Pro 2 Wireless Earbuds, Active Noise Cancellation"), "Apple AirPods Pro 2");
  assert.equal(shortQuery("Apple AirPods Pro 2 Kabellose In-Ear-Kopfhörer"), "Apple AirPods Pro 2", "Amazon.de's German titles");
  assert.equal(shortQuery("Nintendo Switch OLED Model - White"), "Nintendo Switch OLED Model");
  assert.equal(shortQuery("Playstation®5 Digital Edition – 825 GB"), "Playstation 5 Digital Edition", "a real Amazon.de title");
  assert.equal(shortQuery("Wireless Charger Pad"), "Wireless Charger Pad", "a generic word in the first two is kept");
  assert.equal(shortQuery("one two three four five six seven eight nine ten"), "one two three four five six");
});

const ebaySource = (prices: number[]): MarketplaceSource => ({
  id: "ebay",
  search: async () => ({
    source: "ebay",
    status: "ok",
    listings: prices.map(
      (amount, i): Listing => ({
        id: String(i), source: "ebay", title: "Apple AirPods Pro 2", url: `https://ebay.de/${i}`, condition: "new",
        price: { amount, currency: "EUR" }, shipping: { amount: 0, currency: "EUR" }, seller: { handle: `s${i}` },
      }),
    ),
  }),
});

test("a fair Amazon price gets the same verdict an eBay listing would: compared with identical listings", async () => {
  const r = await checkPrice(
    { title: "Apple AirPods Pro 2 Wireless Earbuds", price: { amount: 23900, currency: "EUR" }, from: "amazon" },
    {},
    [ebaySource([24000, 24500, 25000, 25500, 26000, 23500])],
  );
  assert.equal(r.shop, "Amazon");
  assert.equal(r.query, "Apple AirPods Pro 2");
  assert.equal(r.product.check.verdict, "checked");
  assert.equal(r.comparison?.sampleSize, 7, "the six eBay listings and itself");
  assert.ok(r.bestEbay.every((d) => d.listing.source === "ebay"), "the best deals shown are eBay's");
});

test("AirPods at a fifth of the market price on AliExpress: look closer", async () => {
  const r = await checkPrice(
    { title: "Apple AirPods Pro 2", price: { amount: 4900, currency: "EUR" }, from: "aliexpress" },
    {},
    [ebaySource([24000, 24500, 25000, 25500, 26000, 23500])],
  );
  assert.equal(r.shop, "AliExpress");
  assert.equal(r.product.check.verdict, "caution");
  assert.equal(r.deal, null, "a flagged price is never shown as a deal");
  assert.ok(r.product.check.points.some((p) => /Priced well below the median/.test(p.text)));
});

test("with eBay not answering there's no comparison, and no verdict pretends otherwise", async () => {
  const down: MarketplaceSource = { id: "ebay", search: async () => ({ source: "ebay", status: "error", listings: [] }) };
  const r = await checkPrice({ title: "Apple AirPods Pro 2", price: { amount: 23900, currency: "EUR" }, from: "amazon" }, {}, [down]);
  assert.equal(r.ebay.status, "error");
  assert.equal(r.comparison, null);
  assert.notEqual(r.product.check.verdict, "checked");
});

test("model words after a dash or in brackets stay in the search, one of them", () => {
  assert.equal(shortQuery("Nintendo Switch – OLED-Modell, Weiß"), "Nintendo Switch OLED", "an OLED was priced against the plain Switch");
  assert.equal(shortQuery("PlayStation 5 Konsole – Digital Edition (Slim)"), "PlayStation 5 Digital");
  assert.equal(shortQuery("Apple iPhone 15 (128 GB) - Schwarz"), "Apple iPhone 15", "a colour or a size isn't a model word");
  assert.equal(shortQuery("Kindle Paperwhite (16 GB) – Jetzt mit 7-Zoll-Display"), "Kindle Paperwhite");
  assert.equal(shortQuery("Apple Watch Series 9 – GPS, 45 mm"), "Apple Watch Series 9");
});

const titled = (items: [string, number][]): MarketplaceSource => ({
  id: "ebay",
  search: async () => ({
    source: "ebay",
    status: "ok",
    listings: items.map(
      ([title, amount], i): Listing => ({
        id: String(i), source: "ebay", title, url: `https://ebay.de/${i}`, condition: "new",
        price: { amount, currency: "EUR" }, shipping: { amount: 0, currency: "EUR" }, seller: { handle: `s${i}`, feedbackScore: 100 },
      }),
    ),
  }),
});

test("a shop's feature list naming the charging case is the product, not the case alone", async () => {
  const r = await checkPrice(
    { title: "Apple AirPods Pro 2 Kabellose Ohrhörer, Aktive Geräuschunterdrückung, Hörgerätfunktion, USB‑C Ladecase", price: { amount: 22900, currency: "EUR" }, from: "amazon" },
    {},
    [ebaySource([24000, 24500, 25000, 25500, 26000, 23500])],
  );
  assert.equal(r.product.check.verdict, "checked");
  assert.ok(r.comparison, "compared with the eBay listings");
});

test("the best eBay deals shown are the same product: never another size, nor another model", async () => {
  const r = await checkPrice(
    { title: "Apple iPhone 15 (128 GB) - Schwarz", price: { amount: 69900, currency: "EUR" }, from: "amazon" },
    {},
    [
      titled([
        ...Array.from({ length: 6 }, (_, i): [string, number] => [`Apple iPhone 15 128GB Schwarz ${i}`, 60000 + i * 1000]),
        ...Array.from({ length: 6 }, (_, i): [string, number] => [`Apple iPhone 15 512GB Blau ${i}`, 50000 + i * 1000]),
      ]),
    ],
  );
  assert.ok(r.bestEbay.length > 0);
  assert.ok(r.bestEbay.every((d) => /128GB/.test(d.listing.title)), r.bestEbay.map((d) => d.listing.title).join(" | "));
  assert.equal(r.product.title, "Apple iPhone 15 (128 GB) - Schwarz", "shown with the shop's own title");
});

test("a console checked as \"PlayStation 5 Konsole – Digital Edition\" is still compared", async () => {
  const r = await checkPrice(
    { title: "PlayStation 5 Konsole – Digital Edition (Slim)", price: { amount: 39999, currency: "EUR" }, from: "amazon" },
    {},
    [titled(Array.from({ length: 6 }, (_, i): [string, number] => [`Sony PlayStation 5 Digital Edition Slim ${i}`, 40000 + i * 1000]))],
  );
  assert.equal(r.query, "PlayStation 5 Digital");
  assert.equal(r.product.title, "PlayStation 5 Konsole – Digital Edition (Slim)");
  assert.ok(r.comparison, "compared, though the shop says \"Konsole\" in between");
});

const aliSource = (offers: [string, number][]): MarketplaceSource => ({
  id: "aliexpress",
  priceComparable: false,
  search: async () => ({
    source: "aliexpress",
    status: "ok",
    listings: offers.map(([title, amount], i): Listing => ({
      id: `a${i}`, source: "aliexpress", title, url: `https://aliexpress.com/item/${i}.html`, condition: "new",
      price: { amount, currency: "EUR" }, seller: { handle: `ali${i}` }, affiliate: true,
    })),
  }),
});

test("the deal score and the usual range, as the extension's panel shows them", async () => {
  const r = await checkPrice(
    { title: "Apple AirPods Pro 2", price: { amount: 19500, currency: "EUR" }, from: "amazon" },
    {},
    [ebaySource([24000, 24500, 25000, 25500, 26000, 23500])],
  );
  assert.ok(r.comparison);
  assert.deepStrictEqual(r.deal, { pct: -21, tone: "good" }, "195 € against the 247.50 € typical of the six eBay prices");
  assert.deepStrictEqual(
    r.market,
    { low: 24000, high: 25500, count: 6, typical: 24750, currency: "EUR", basis: "new" },
    "fewer than ten: the middle half, so one odd listing isn't the bottom of the range",
  );
  const down: MarketplaceSource = { id: "ebay", search: async () => ({ source: "ebay", status: "error", listings: [] }) };
  const none = await checkPrice({ title: "Apple AirPods Pro 2", price: { amount: 19500, currency: "EUR" }, from: "amazon" }, {}, [down]);
  assert.strictEqual(none.deal, null, "no market, no score");
  assert.strictEqual(none.market, null);
});

test("AliExpress is shown as an alternative only for the same product at a believable price, never in the market", async () => {
  const ebay = ebaySource([24000, 24500, 25000, 25500, 26000, 23500]);
  const r = await checkPrice(
    { title: "Apple AirPods Pro 2", price: { amount: 24900, currency: "EUR" }, from: "otto" },
    {},
    [ebay, aliSource([["Apple AirPods Pro 2 TWS", 2900], ["Apple AirPods Pro 2", 21000], ["Apple AirPods Pro 2", 19900], ["Hülle für Apple AirPods Pro 2", 900]])],
  );
  assert.strictEqual(r.comparison!.median, 24900, "AliExpress prices don't move the market price");
  assert.strictEqual(r.elsewhere?.listing.id, "a2", "the cheapest believable one: 29 € is a copy, the case isn't the product");
  assert.strictEqual(r.elsewhere?.total.amount, 19900);
  const onAli = await checkPrice(
    { title: "Apple AirPods Pro 2", price: { amount: 24900, currency: "EUR" }, from: "aliexpress" },
    {},
    [ebay, aliSource([["Apple AirPods Pro 2", 21000]])],
  );
  assert.strictEqual(onAli.elsewhere, null, "already on AliExpress");
  const dearer = await checkPrice(
    { title: "Apple AirPods Pro 2", price: { amount: 19000, currency: "EUR" }, from: "otto" },
    {},
    [ebay, aliSource([["Apple AirPods Pro 2", 21000]])],
  );
  assert.strictEqual(dearer.elsewhere, null, "not when it costs more than the page the shopper is on");
});

test("a new product is measured against new listings, not refurbished ones, when there are enough", async () => {
  const listings = (rows: [string, number][]): MarketplaceSource => ({
    id: "ebay",
    search: async () => ({
      source: "ebay",
      status: "ok",
      listings: rows.map(([condition, amount], i): Listing => ({
        id: String(i), source: "ebay", title: "Apple iPhone 15 128GB", url: `https://ebay.de/${i}`, condition: condition as Listing["condition"],
        price: { amount, currency: "EUR" }, shipping: { amount: 0, currency: "EUR" }, seller: { handle: `s${i}`, feedbackScore: 100 },
      })),
    }),
  });
  const refurbished: [string, number][] = [36900, 38200, 38900, 39900, 43000, 44500, 46900, 48900].map((p) => ["refurbished", p]);
  const iphone = { title: "Apple iPhone 15 (128 GB) - Schwarz", price: { amount: 69900, currency: "EUR" }, from: "amazon" as const };

  const mostlyRefurbished = await checkPrice(iphone, {}, [listings([...refurbished, ["new", 50699], ["new", 59900]])]);
  assert.strictEqual(mostlyRefurbished.market?.basis, "new-refurbished", "two new ones aren't a market: the pool, said as such");

  const enoughNew = await checkPrice(iphone, {}, [listings([...refurbished, ...[64900, 67900, 69900, 71900, 72900].map((p): [string, number] => ["new", p])])]);
  assert.strictEqual(enoughNew.market?.basis, "new");
  assert.strictEqual(enoughNew.market?.typical, 69900);
  assert.deepStrictEqual(enoughNew.deal, { pct: 0, tone: "fair" }, "the usual price for a new one, not +53%");
});
