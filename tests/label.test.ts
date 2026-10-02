import { test } from "node:test";
import assert from "node:assert";
import { analyse, type Flag } from "../lib/marketplace/anomaly";
import { checkLabel, bestCheckedDeals, describeSaving, CHECKED_MEANS } from "../lib/marketplace/label";
import { priceCheckFor } from "../lib/checkout/eligibility";
import { listingKey, type Listing, type SourceResult } from "../lib/marketplace/types";

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "l1",
    source: "stub",
    title: "thing",
    url: "https://example.invalid/1",
    price: { amount: 10000, currency: "EUR" },
    shipping: { amount: 0, currency: "EUR" },
    condition: "new",
    seller: { handle: "seller_a" },
    ...over,
  };
}

const honest = (n: number, amount = 10000, condition: Listing["condition"] = "new", prefix = "ok") =>
  Array.from({ length: n }, (_, i) => listing({ id: `${prefix}-${i}`, price: { amount, currency: "EUR" }, condition, seller: { handle: `${prefix}${i}` } }));

const ok = (listings: Listing[], source: SourceResult["source"] = "stub"): SourceResult => ({ source, status: "ok", listings });

/** Analyse, then label every listing the way the search page does. */
function labelled(results: SourceResult[], badge: (l: Listing) => boolean = () => false) {
  const a = analyse(results);
  const flags = new Map<string, Flag[]>();
  for (const f of a.flags) {
    const k = listingKey({ source: f.source, id: f.listingId });
    flags.set(k, [...(flags.get(k) ?? []), f]);
  }
  const all = results.flatMap((r) => r.listings);
  const labels = new Map(all.map((l) => [listingKey(l), checkLabel(l, flags.get(listingKey(l)) ?? [], priceCheckFor(l, a), a, badge(l))]));
  return { a, all, labelOf: (l: Listing) => labels.get(listingKey(l))! };
}

test("a fairly priced listing with no flags is SigPath-checked, and says what was compared", () => {
  const fair = listing({ id: "fair", price: { amount: 9500, currency: "EUR" } });
  const { labelOf } = labelled([ok([...honest(8), fair])]);
  const l = labelOf(fair);
  assert.equal(l.verdict, "checked");
  assert.equal(l.headline, "SigPath-checked");
  assert.match(l.points[0].text, /compared across 9 new or refurbished listings on the demo feed/);
  assert.ok(l.points.every((p) => p.tone === "good"));
});

test("any flag makes it 'Look closer', listing every reason", () => {
  const bait = listing({ id: "bait", price: { amount: 2000, currency: "EUR" } });
  const { labelOf } = labelled([ok([...honest(8), bait])]);
  const l = labelOf(bait);
  assert.equal(l.verdict, "caution");
  assert.equal(l.headline, "Look closer");
  assert.ok(l.points.some((p) => p.tone === "warn" && /median/.test(p.text)));
});

test("a price that couldn't be compared is 'Not price-checked' — neutral, with the reason, never a warning", () => {
  const lonelyUsed = listing({ id: "used-1", condition: "used", price: { amount: 3000, currency: "EUR" } });
  const { labelOf } = labelled([ok([...honest(8), lonelyUsed])]);
  const l = labelOf(lonelyUsed);
  assert.equal(l.verdict, "unchecked");
  assert.match(l.points[0].text, /enough used listings/);
  assert.ok(!l.points.some((p) => p.tone === "warn"), "an uncomparable price is not an accusation");
});

test("a verified badge never upgrades the verdict — it vouches for the account, not the price", () => {
  const lonelyUsed = listing({ id: "used-1", condition: "used", seller: { handle: "verified_shop" } });
  const bait = listing({ id: "bait", price: { amount: 2000, currency: "EUR" }, seller: { handle: "verified_shop" } });
  const { labelOf } = labelled([ok([...honest(8), lonelyUsed, bait])], (l) => l.seller.handle === "verified_shop");
  assert.equal(labelOf(lonelyUsed).verdict, "unchecked");
  assert.equal(labelOf(bait).verdict, "caution");
  assert.ok(labelOf(bait).points.some((p) => /Verified seller/.test(p.text) && p.tone === "info"));
});

test("a verified seller's checked listing shows the badge as a point", () => {
  const fair = listing({ id: "fair", seller: { handle: "verified_shop" } });
  const { labelOf } = labelled([ok([...honest(8), fair])], (l) => l.seller.handle === "verified_shop");
  assert.ok(labelOf(fair).points.some((p) => /Verified seller/.test(p.text) && p.tone === "good"));
});

test("a flag on one marketplace's listing never lands on another marketplace's listing with the same id", () => {
  // Ids are only unique within a marketplace. Grouping by id alone used to
  // hang eBay "123"'s flag on Etsy "123" — and would now make it 'Look closer'.
  const ebayBait = listing({ id: "123", source: "ebay", price: { amount: 2000, currency: "EUR" } });
  const stubFair = listing({ id: "123", source: "stub", price: { amount: 10000, currency: "EUR" } });
  const ebayHonest = honest(8, 10000, "new", "e").map((l) => ({ ...l, source: "ebay" as const }));
  const { a, labelOf } = labelled([ok([...ebayHonest, ebayBait], "ebay"), ok([...honest(8), stubFair])]);
  assert.ok(a.flags.some((f) => f.source === "ebay" && f.listingId === "123"));
  assert.equal(labelOf(ebayBait).verdict, "caution");
  assert.equal(labelOf(stubFair).verdict, "checked");
});

// --- best checked deals ------------------------------------------------------------

test("the best deal is the cheapest CHECKED listing — a flagged bargain never wins", () => {
  const bait = listing({ id: "bait", price: { amount: 2000, currency: "EUR" } });
  const good = listing({ id: "good", price: { amount: 8000, currency: "EUR" } });
  const { a, all, labelOf } = labelled([ok([...honest(8), bait, good])]);
  const [best] = bestCheckedDeals(all, labelOf, a);
  assert.equal(best.listing.id, "good");
  assert.equal(best.group, "new");
  assert.equal(best.belowMedian?.amount, 2000, "median 100.00, deal 80.00");
  assert.match(describeSaving(best) ?? "", /below the typical new price$/);
});

test("new and used get a best deal each, each saving measured against its own median", () => {
  const newDeal = listing({ id: "n", price: { amount: 9000, currency: "EUR" } });
  const usedDeal = listing({ id: "u", condition: "used", price: { amount: 4000, currency: "EUR" } });
  const { a, all, labelOf } = labelled([ok([...honest(8), newDeal, ...honest(6, 5000, "used", "used"), usedDeal])]);
  const deals = bestCheckedDeals(all, labelOf, a);
  assert.deepEqual(deals.map((d) => [d.group, d.listing.id]), [["new", "n"], ["used", "u"]]);
  assert.equal(deals[0].belowMedian?.amount, 1000);
  assert.equal(deals[1].belowMedian?.amount, 1000);
});

test("no checked listings, no best deal", () => {
  const { a, all, labelOf } = labelled([ok(honest(3))]); // too few to compare
  assert.deepEqual(bestCheckedDeals(all, labelOf, a), []);
});

test("the explainer says checked is not a guarantee, and what to do if it's fake", () => {
  assert.match(CHECKED_MEANS, /isn't a guarantee/);
  assert.match(CHECKED_MEANS, /report it/);
});
