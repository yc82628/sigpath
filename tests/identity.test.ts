import { test } from "node:test";
import assert from "node:assert";
import { identify, sameProduct, describeSpecs } from "../lib/marketplace/identity";
import { analyse } from "../lib/marketplace/anomaly";
import { priceCheckFor } from "../lib/checkout/eligibility";
import { withLabels } from "../lib/marketplace/label";
import { searchAll } from "../lib/marketplace/search";
import { StubSource } from "../lib/marketplace/sources/stub";
import { listingKey, type Listing, type SourceResult } from "../lib/marketplace/types";

const Q = "ThinkPad X1";

// --- reading a title ------------------------------------------------------------

test("identity: reads variant, generation, storage and RAM", () => {
  const i = identify("Lenovo ThinkPad X1 Carbon Gen 11 i7 16GB RAM 512GB SSD", Q);
  assert.deepStrictEqual([i.kind, i.variant, i.generation, i.storageGB, i.ramGB], ["product", ["carbon"], 11, 512, 16]);
  const j = identify("ThinkPad X1 Carbon 6th Gen 8GB 256GB", Q);
  assert.deepStrictEqual([j.generation, j.storageGB, j.ramGB], [6, 256, 8], "two unmarked figures: the smaller is RAM");
  assert.strictEqual(identify("ThinkPad X1 Yoga 1TB", Q).storageGB, 1024);
  assert.deepStrictEqual(identify("iPhone 15 Pro Max 256GB", "iPhone 15").variant, ["max", "pro"]);
  assert.strictEqual(describeSpecs(i), "Carbon, Gen 11, 512 GB storage, 16 GB RAM");
});

test("identity: model words count only straight after the product name", () => {
  assert.deepStrictEqual(identify("ThinkPad X1 - URGENT SALE, must go today", Q).variant, [], '"go" here is not a Surface Go');
  assert.deepStrictEqual(identify("Sealed ThinkPad X1", Q).variant, []);
  assert.strictEqual(identify("Carbon X1 ThinkPad", Q).variant, undefined, "name not in order: variant unknown");
  assert.deepStrictEqual(identify("Nintendo Switch OLED white", "Nintendo Switch OLED").variant, [], "words the shopper searched are not variants");
});

test("identity: accessories, but not products that come with one", () => {
  assert.strictEqual(identify("65W USB-C Charger for ThinkPad X1", Q).kind, "accessory");
  assert.strictEqual(identify("Sleeve fits ThinkPad X1 14 inch", Q).kind, "accessory");
  assert.strictEqual(identify("Keyboard for ThinkPad X1", Q).kind, "accessory", "sold for use with it");
  assert.strictEqual(identify("ThinkPad X1 with original charger and case", Q).kind, "product");
  assert.strictEqual(identify("ThinkPad X1 charger included", Q).kind, "product");
  assert.strictEqual(identify("ThinkPad X1 for students and work", Q).kind, "product");
  assert.strictEqual(identify("Leather laptop sleeve 14 inch", "laptop sleeve").kind, "product", "the shopper searched for a sleeve");
  assert.match(identify("Charger for ThinkPad X1", Q).kindReason!, /accessory \(charger\)/);
});

test("identity: for-parts units, but not negated damage", () => {
  assert.strictEqual(identify("ThinkPad X1 for parts, not working", Q).kind, "parts");
  assert.strictEqual(identify("iPhone 14 iCloud locked", "iPhone 14").kind, "parts");
  assert.strictEqual(identify("ThinkPad X1, screen not cracked, never broken", Q).kind, "product");
  assert.strictEqual(identify("ThinkPad X1 no scratches, not faulty", Q).kind, "product");
});

test("identity: unknown specs never conflict; known different ones do", () => {
  const id = (t: string) => identify(t, Q);
  assert.ok(sameProduct(id("ThinkPad X1 Carbon 16GB 512GB"), id("ThinkPad X1 Carbon")));
  assert.ok(!sameProduct(id("ThinkPad X1 Carbon 512GB"), id("ThinkPad X1 Carbon 1TB")));
  assert.ok(!sameProduct(id("ThinkPad X1 Carbon"), id("ThinkPad X1 Yoga")));
  assert.ok(!sameProduct(id("ThinkPad X1 Gen 6"), id("ThinkPad X1 Gen 11")));
  assert.ok(sameProduct(id("Carbon X1 ThinkPad"), id("ThinkPad X1 Yoga")), "an unknown variant matches anything");
  assert.ok(!sameProduct(id("Charger for ThinkPad X1"), id("ThinkPad X1")), "an accessory is never the product");
});

// --- comparing like with like --------------------------------------------------------

let n = 0;
function listing(title: string, euros: number, over: Partial<Listing> = {}): Listing {
  n++;
  return {
    id: `l${n}`,
    source: "stub",
    title,
    url: `https://example.invalid/${n}`,
    price: { amount: euros * 100, currency: "EUR" },
    shipping: { amount: 0, currency: "EUR" },
    condition: "new",
    seller: { handle: `s${n}` },
    ...over,
  };
}
const ok = (listings: Listing[]): SourceResult[] => [{ source: "stub", status: "ok", listings }];
const many = (k: number, title: string, euros: number) => Array.from({ length: k }, (_, i) => listing(title, euros + i * 10));

test("comparison: an older generation is priced against its own generation, not the newest", () => {
  // Pooled, the Gen 6 units sat far below a median dragged up by Gen 11 and were flagged as scams.
  const gen6 = many(6, "ThinkPad X1 Gen 6", 300);
  const a = analyse(ok([...gen6, ...many(7, "ThinkPad X1 Gen 11", 1000)]), { query: Q });
  assert.ok(!a.flags.some((f) => f.kind === "underpriced"), JSON.stringify(a.flags));
  const c = a.comparisons[listingKey(gen6[0])];
  assert.strictEqual(c.sampleSize, 6);
  assert.ok(c.median < 40000);
});

test("comparison: a scam is still caught against its own configuration", () => {
  const scam = listing("ThinkPad X1 Gen 11", 300);
  const a = analyse(ok([...many(6, "ThinkPad X1 Gen 11", 1000), scam, ...many(6, "ThinkPad X1 Gen 6", 290)]), { query: Q });
  const f = a.flags.find((x) => x.listingId === scam.id);
  assert.strictEqual(f?.kind, "underpriced");
  assert.match(f!.message, /median of 7 comparable listings/);
});

test("comparison: accessories and for-parts units are never compared, never flagged, and say why", () => {
  const charger = listing("Charger for ThinkPad X1", 20);
  const broken = listing("ThinkPad X1 for parts, not working", 60, { condition: "used" });
  const a = analyse(ok([...many(6, "ThinkPad X1", 900), ...many(6, "ThinkPad X1", 500).map((l) => ({ ...l, condition: "used" as const })), charger, broken]), { query: Q });
  for (const l of [charger, broken]) {
    assert.ok(!a.flags.some((f) => f.listingId === l.id), "no scam flag on an honest accessory or parts unit");
    assert.ok(!a.priceChecked.includes(listingKey(l)));
    const pc = priceCheckFor(l, a);
    assert.strictEqual(pc.checked, false);
  }
  assert.match((priceCheckFor(charger, a) as { reason: string }).reason, /accessory/);
  assert.match((priceCheckFor(broken, a) as { reason: string }).reason, /for parts/);
});

test("comparison: too few of the same configuration means not compared, with the reason", () => {
  const carbons = many(2, "ThinkPad X1 Carbon", 1200);
  const a = analyse(ok([...many(6, "ThinkPad X1", 900), ...carbons]), { query: Q });
  const pc = priceCheckFor(carbons[0], a);
  assert.strictEqual(pc.checked, false);
  assert.match((pc as { reason: string }).reason, /Only 2 listings of the same model and configuration/);
});

test("demo feed end to end: the charger and the parts unit are 'Not price-checked', the scams still 'Look closer'", async () => {
  const r = withLabels(await searchAll("ThinkPad X1", [new StubSource()], { limit: 20 }));
  const verdict = (suffix: string) => r.listings.find((l) => l.url.endsWith(suffix))!.check;
  assert.strictEqual(verdict("/accessory").verdict, "unchecked");
  assert.match(verdict("/accessory").points[0].text, /accessory/);
  assert.strictEqual(verdict("/parts").verdict, "unchecked");
  assert.match(verdict("/parts").points[0].text, /for parts/);
  assert.strictEqual(verdict("/bait").verdict, "caution");
  assert.strictEqual(verdict("/used-bait").verdict, "caution");
  // Neither honest listing can be a best deal.
  const best = new Set(r.bestCheckedDeals.map((d) => d.listing));
  assert.ok(![...best].some((k) => k.endsWith("accessory") || k.endsWith("parts")));
});
