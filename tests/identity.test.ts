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
  // Seen checking an AliExpress case: a German compound names its last part.
  assert.strictEqual(
    identify("Schutzhülle für Airpods Pro 2 Pro 3 USB C Kopfhörer-Hülle", "Schutzhülle für Airpods Pro 2 Pro").kind,
    "product",
    "the shopper searched for a Hülle",
  );
  assert.strictEqual(identify("Ladekabel USB-C 2m", "USB-C Kabel").kind, "accessory", "but a Kabel isn't a Ladekabel");
  assert.strictEqual(identify("Hülle für AirPods Pro 2", "AirPods Pro 2").kind, "accessory");
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

test("identity: one earbud of a pair is a part, not a cheap pair", () => {
  // Seen live on eBay.de as the "best checked deal" for AirPods Pro 2 at 60.80 EUR.
  assert.strictEqual(identify("Apple AirPods Pro 2 Generation USB-C (A3048) – Links Original", "AirPods Pro 2").kind, "parts");
  assert.strictEqual(identify("AirPods Pro 2 rechts Ersatz", "AirPods Pro 2").kind, "parts");
  assert.strictEqual(identify("AirPods Pro 2nd gen right AirPod only", "AirPods Pro 2").kind, "parts");
  assert.strictEqual(identify("Apple AirPods Pro 2 mit MagSafe Ladecase USB-C", "AirPods Pro 2").kind, "product");
});

test("iCloud-locked and faulty units are for parts, not the working product", () => {
  for (const [title, query] of [
    ["Apple AirPods Pro 3 In-Ear Bluetooth Kopfhörer ANC Weiß iCloud Lock", "AirPods Pro 3"],
    ["iPhone 13 128GB iCloud-Sperre", "iPhone 13"],
    ["iPad Air 5 mit Aktivierungssperre", "iPad Air 5"],
    ["Apple Watch 8 activation lock", "Apple Watch 8"],
    ["Apple AirPods Pro (1. Gen) OVP + Zubehör – ANC / Transparenz rauscht", "AirPods Pro"],
    ["AirPods Pro 2 Ohrhörer knistert", "AirPods Pro 2"],
    ["Sony WH-1000XM4 Wackelkontakt", "Sony WH-1000XM4"],
    ["Bose QC45 crackling left side", "Bose QC45"],
  ]) {
    assert.strictEqual(identify(title, query).kind, "parts", title);
  }
});

test("...but saying it is free of those faults, or noise cancelling, isn't one", () => {
  for (const [title, query] of [
    ["Apple AirPods Pro 2 kein Rauschen, wie neu", "AirPods Pro 2"],
    ["AirPods Pro 2 mit aktiver Rauschunterdrückung", "AirPods Pro 2"],
    ["iPhone 13 128GB ohne iCloud-Sperre, entsperrt", "iPhone 13"],
    ["Sony WH-1000XM4 no crackling, perfect condition", "Sony WH-1000XM4"],
  ]) {
    assert.strictEqual(identify(title, query).kind, "product", title);
  }
});

test("AliExpress-style add-ons are accessories: cleaning kits, ear hooks, and titles that open with \"For\"", () => {
  for (const title of [
    "Multifunctional Cleaning Kit Keycap Puller Brush Earbuds Cleaning Pen For Keyboard AirPods Pro 1 2 3 Bluetooth Earphones",
    "For Apple AirPods 1 2 3 Pro Earphone Ear Hook Portable Silicone Anti-lost Earhooks",
    "Für AirPods Pro 2 Silikon Hülle Schwarz",
    "AirPods Pro Reinigungsset 3 in 1",
  ]) {
    assert.strictEqual(identify(title, "AirPods Pro").kind, "accessory", title);
  }
  // The product itself, even with an extra thrown in, or brushed metal, stays the product.
  for (const title of ["Apple AirPods Pro 2 mit Ladecase und Reinigungsstift", "MacBook Air M2 brushed silver"]) {
    assert.strictEqual(identify(title, title.startsWith("Apple") ? "AirPods Pro" : "MacBook Air").kind, "product", title);
  }
});

test("repair parts, packs and \"… for <product>\" add-ons are accessories, the console itself isn't", () => {
  const q = "Nintendo Switch OLED";
  for (const title of [
    "Skull & Co. JoyCon Replacement Joystick Covers Repair Parts for Nintendo Switch/ OLED/ Lite",
    "10/20PCS 5.0 6.0 GINFULL TMR Joysticks for Nintendo Switch / OLED / Lite Joy-Con",
    "2pcs=1pair For Switch OLED Game Console Host Anti-slip Rubber Feet Pad",
    "Schutzfolie 3 Stück für Nintendo Switch OLED",
  ]) {
    assert.strictEqual(identify(title, q).kind, "accessory", title);
  }
  for (const title of ["Nintendo Switch OLED-Modell HEG-001 + USB Kabel + Joy-Con (Weiß)", "nintendo switch oled", "Nintendo Switch OLED weiß, top Zustand, 2 Spiele"]) {
    assert.strictEqual(identify(title, q).kind, "product", title);
  }
});

test("spare parts taken out of a phone are accessories, the phone isn't", () => {
  for (const title of ["✅100%Original Apple iPhone 13 Pro Ladebuchse Mikrofon DockFlex", "Apple IPhone 13 Pro 100% Original Housing Rahmen grau pulled", "iPhone 13 Flexkabel Lautstärke"]) {
    assert.strictEqual(identify(title, "iPhone 13").kind, "accessory", title);
  }
  assert.strictEqual(identify("Apple iPhone 13 mini 128GB 81% Midnight 12 Monate Gewährleistung", "iPhone 13").kind, "product");
});
