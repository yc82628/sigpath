import { test } from "node:test";
import assert from "node:assert";
import { checkDiscount, referenceOf } from "../lib/marketplace/discount";

/**
 * Is the advertised discount real? (lib/marketplace/discount.ts) Prices in
 * cents. The market is what the same product sells for on eBay right now.
 */

const market = { typical: 16400, high: 17990 }; // Sony WF-1000XM5, new, on eBay (2026-11-10)

test("the label says what the struck-out price is, in German and English", () => {
  assert.equal(referenceOf("RRP:  €199.00"), "rrp");
  assert.equal(referenceOf("UVP: 199,00 €"), "rrp");
  assert.equal(referenceOf("Unverb. Preisempf.: 199,00 €"), "rrp");
  assert.equal(referenceOf("List Price:"), "rrp");
  assert.equal(referenceOf("Was:"), "was");
  assert.equal(referenceOf("Vorher:"), "was");
  assert.equal(referenceOf("Niedrigster Preis der letzten 30 Tage:"), "lowest30");
  assert.equal(referenceOf("Lowest price in 30 days"), "lowest30");
  assert.equal(referenceOf(""), "unknown");
});

test("a struck-out price above what the product sells for is an inflated discount, even a small one", () => {
  // The live case: 189 € "−5% from RRP 199 €", while new ones usually sell for 164 €.
  const d = checkDiscount({ price: 18900, was: 19900, reference: "rrp", market, checked: true })!;
  assert.equal(d.claimedPct, 5);
  assert.equal(d.vsMarketPct, -15, "15% ABOVE the market");
  assert.equal(d.verdict, "inflated");
  // A big claim from an invented price: −40%, really −6%.
  const big = checkDiscount({ price: 15400, was: 25700, reference: "was", market, checked: true })!;
  assert.equal(big.claimedPct, 40);
  assert.equal(big.vsMarketPct, 6);
  assert.equal(big.verdict, "inflated");
});

test("a discount that holds up against the market is real", () => {
  // −20% from 180 €, the top of the usual range: about what it saves against the market too.
  const d = checkDiscount({ price: 14400, was: 18000, market, checked: true })!;
  assert.equal(d.claimedPct, 20);
  assert.equal(d.vsMarketPct, 12);
  assert.equal(d.verdict, "real", "the struck-out price is the usual range's top, the gap only 8 points");
  // A struck-out price within the usual range is never called inflated, whatever the gap.
  assert.equal(checkDiscount({ price: 9900, was: 17000, market, checked: true })!.verdict, "real");
});

test("no cheaper than the 30-day low is no discount, the law's own measure", () => {
  const d = checkDiscount({ price: 15900, was: 19900, reference: "was", lowest30: 15900, market, checked: true })!;
  assert.equal(d.verdict, "not-lower");
  assert.equal(checkDiscount({ price: 15900, was: 19900, lowest30: 14900, market: null, checked: false })!.verdict, "not-lower", "even without a market");
  assert.notEqual(checkDiscount({ price: 14000, was: 19900, lowest30: 14900, market, checked: true })!.verdict, "not-lower", "below its 30-day low it is a cut");
});

test("without a checked price there's nothing to compare with, and no struck-out price is no claim", () => {
  assert.equal(checkDiscount({ price: 15400, was: 25700, market, checked: false })!.verdict, "unchecked", "a flagged price isn't measured against the market");
  assert.equal(checkDiscount({ price: 15400, was: 25700, market: null, checked: true })!.verdict, "unchecked");
  assert.equal(checkDiscount({ price: 15400, was: null, market, checked: true }), null);
  assert.equal(checkDiscount({ price: 15400, was: 15400, market, checked: true }), null, "equal is no discount");
  assert.equal(checkDiscount({ price: 15400, was: 12000, market, checked: true }), null, "a 'was' below the price is no discount");
  assert.equal(checkDiscount({ price: 19900, was: 19950, market, checked: true }), null, "under 1% isn't a claim");
});
