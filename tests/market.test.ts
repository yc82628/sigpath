import { test } from "node:test";
import assert from "node:assert";
import { BINS, dealScore, dealTone, marketSnapshot, quantile } from "../lib/marketplace/market";
import { analyse } from "../lib/marketplace/anomaly";
import type { Listing, SourceResult } from "../lib/marketplace/types";

/**
 * The market overview and the deal score: drawn only from listings whose
 * price was really compared, never from accessories or the demo feed.
 */

const at = (id: string, euros: number, condition: Listing["condition"] = "new", title = "Nintendo Switch OLED", source: Listing["source"] = "ebay"): Listing => ({
  id,
  source,
  title,
  url: `https://ebay.de/${id}`,
  price: { amount: euros * 100, currency: "EUR" },
  condition,
  seller: { handle: id, feedbackScore: 50 },
});
const ok = (listings: Listing[], source: Listing["source"] = "ebay"): SourceResult => ({ source, status: "ok", listings });

test("quantiles by nearest rank", () => {
  const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.strictEqual(quantile(v, 0), 10);
  assert.strictEqual(quantile(v, 0.1), 20);
  assert.strictEqual(quantile(v, 0.9), 90);
  assert.strictEqual(quantile(v, 1), 100);
});

test("the market per condition: typical price, the usual range, and where prices sit", () => {
  const used = [150, 160, 170, 180, 185, 190, 200, 230].map((p, i) => at(`u${i}`, p, "used"));
  const fresh = [190, 200, 205, 210, 220].map((p, i) => at(`n${i}`, p));
  const charger = at("c", 15, "used", "Ladegerät für Nintendo Switch OLED");
  const listings = [...used, ...fresh, charger];
  const a = analyse([ok(listings)], { query: "Nintendo Switch OLED" });
  const groups = marketSnapshot(listings, a);
  assert.deepStrictEqual(groups.map((g) => g.group), ["new", "used"]);
  const u = groups.find((g) => g.group === "used")!;
  assert.strictEqual(u.typical, a.used!.median);
  assert.strictEqual(u.count, 8, "the charger isn't part of the used market");
  assert.strictEqual(u.min, 15000);
  assert.strictEqual(u.max, 23000);
  assert.strictEqual(u.bins.length, BINS);
  assert.strictEqual(u.bins.reduce((x, y) => x + y, 0), 8);
  assert.ok(u.low >= u.min && u.high <= u.max && u.low <= u.typical && u.typical <= u.high);
});

test("no picture without a comparison, and the demo feed is never mixed with a real marketplace", () => {
  assert.deepStrictEqual(marketSnapshot([at("x", 100)], analyse([ok([at("x", 100)])])), [], "one listing: no market");
  const real = [190, 200, 205, 210, 220].map((p, i) => at(`n${i}`, p));
  const demo = [20, 30, 40, 50, 60].map((p, i) => at(`d${i}`, p, "new", "Nintendo Switch OLED", "stub"));
  const all = [...real, ...demo];
  const [g] = marketSnapshot(all, analyse([ok(real), ok(demo, "stub")], { query: "Nintendo Switch OLED" }));
  assert.strictEqual(g.min, 19000, "only the real listings");
});

test("the deal score: percent from the typical price of what it was compared with", () => {
  const listings = [200, 200, 200, 200, 200, 156, 230].map((p, i) => at(`n${i}`, p));
  const a = analyse([ok(listings)], { query: "Nintendo Switch OLED" });
  assert.strictEqual(dealScore(listings[5], a), -22);
  assert.strictEqual(dealScore(listings[6], a), 15);
  assert.strictEqual(dealScore(listings[0], a), 0);
  assert.strictEqual(dealScore(at("other", 10, "new", "Hülle für Nintendo Switch OLED"), a), null, "not compared: no score");
  assert.deepStrictEqual([dealTone(-22), dealTone(-9), dealTone(0), dealTone(9), dealTone(15)], ["good", "fair", "fair", "fair", "high"]);
});

test("a wide spread suggests a more specific search; a narrow one doesn't", async () => {
  const { isWide } = await import("../lib/marketplace/market");
  const g = (low: number, high: number) => ({ group: "used" as const, typical: low, count: 9, low, high, min: low, max: high, bins: [], typicalBin: 0 });
  assert.ok(isWide(g(5519, 19495)), "AirPods Pro, all generations: 55 to 195 €");
  assert.ok(!isWide(g(15768, 21900)), "Switch OLED: 158 to 219 €");
  assert.ok(!isWide(g(10000, 20000)), "exactly double isn't wide");
});

test("a checked price far under the typical one says so, rather than \"in line\"", async () => {
  const { withLabels } = await import("../lib/marketplace/label");
  const { translateCheck } = await import("../lib/i18n/checks");
  const listings = [200, 200, 200, 200, 200, 200, 104, 190].map((p, i) => at(`n${i}`, p));
  const r = withLabels({ listings, analysis: analyse([ok(listings)], { query: "Nintendo Switch OLED" }) });
  const text = (id: string) => r.listings.find((l) => l.id === id)!.check.points[0].text;
  assert.strictEqual(r.listings.find((l) => l.id === "n6")!.check.verdict, "checked", "48% under isn't flagged");
  assert.strictEqual(text("n6"), "Well below the market: 48% under the median of 8 listings of the same product on eBay, though not low enough to be flagged.");
  assert.match(text("n7"), /^Price in line with the market/);
  assert.strictEqual(
    translateCheck(text("n6"), "de"),
    "Deutlich unter dem Markt: 48 % unter dem Median von 8 Angeboten desselben Produkts auf eBay, aber nicht so niedrig, dass es markiert wird.",
  );
});
