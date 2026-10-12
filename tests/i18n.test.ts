import { test } from "node:test";
import assert from "node:assert";
import { searchAll } from "../lib/marketplace/search";
import { StubSource } from "../lib/marketplace/sources/stub";
import { labelSearch, describeSaving } from "../lib/marketplace/label";
import { checkoutEligibility, priceCheckFor } from "../lib/checkout/eligibility";
import { identify } from "../lib/marketplace/identity";
import { hasGerman, translateCheck, translateWhere } from "../lib/i18n/checks";
import { MESSAGES } from "../lib/i18n/messages";
import { pickLang } from "../lib/i18n/lang";

/**
 * The German site translates the checks' English sentences (lib/i18n/checks.ts).
 * These tests run real searches through the real checks and fail if any
 * sentence they produce has no German, so a new or reworded reason can't
 * quietly show up in English on the German pages.
 */

test("every reason a search produces has a German version", async () => {
  const seen = new Set<string>();
  for (const q of ["ThinkPad X1", "AirPods Pro 2", "iPhone 13 128GB", "Nintendo Switch OLED", "Sony A7 III"]) {
    const result = await searchAll(q, [new StubSource("EUR", 0)], { limit: 25 });
    const labelled = labelSearch(result);
    for (const l of result.listings) {
      const label = labelled.labelOf(l);
      seen.add(label.headline);
      for (const p of label.points) seen.add(p.text);
      const e = checkoutEligibility(l, labelled.flagsOf(l), priceCheckFor(l, result.analysis));
      if (!e.eligible) seen.add(e.reason);
    }
    for (const d of labelled.deals) {
      const s = describeSaving(d);
      if (s) seen.add(s);
    }
    if (result.analysis.status !== "ok" && result.analysis.reason) seen.add(result.analysis.reason);
  }
  assert.ok(seen.size > 15, `a real spread of sentences (${seen.size})`);
  const missing = [...seen].filter((t) => !hasGerman(t));
  assert.deepEqual(missing, []);
});

test("the sentences that need a particular listing to appear are translated too", () => {
  const samples = [
    "Seller account is 3 days old.",
    "Seller account is 2 years old.",
    "This photo appears on 3 different seller accounts on the same marketplace.",
    "Seller has 1200 ratings (98% positive) on eBay; account age isn't published, so it wasn't checked.",
    "Seller history not checked: the demo feed doesn't publish it.",
    "Photo not checked: new items often show the maker's own photo.",
    "Photo not checked: it's eBay's stock photo for this product.",
    "A verified buyer's fake-product report against this seller was upheld after review.",
    "2 verified buyers' fake-product reports against this seller were upheld after review.",
    "Verified seller: proved control of this account and passed a live check. That vouches for the account, not this price.",
    "Verified business: registered as Muster GmbH in DE, owns muster.de. That vouches for who runs the account, not this price.",
    "Priced above most of the 12 used listings of the same model and configuration (Carbon, Gen 11, 512 GB storage) on eBay (median 450.00 EUR). You may find it cheaper.",
    "Price comparison is unavailable: ebay did not respond, so any median would be taken over a biased sample.",
    "Shipping cost isn't published, so the total can't be quoted.",
    "AliExpress items are bought on AliExpress, through its own checkout.",
    "It isn't in today's search results, so it couldn't be checked again.",
    "Not SigPath-checked today: Look closer.",
    "A demo listing: there is no live price.",
    identify("Charger for ThinkPad X1", "ThinkPad X1").kindReason!,
    identify("ThinkPad X1 for parts, not working", "ThinkPad X1").kindReason!,
    identify("Keyboard for ThinkPad X1", "ThinkPad X1").kindReason!,
  ];
  const missing = samples.filter((t) => !hasGerman(t));
  assert.deepEqual(missing, []);
});

test("German reads as German, keeps the numbers and names, and English is untouched", () => {
  assert.equal(
    translateCheck("Priced well below the median of 5 comparable used listings on the demo feed.", "de"),
    "Deutlich unter dem Median von 5 vergleichbaren gebrauchten Angeboten im Demo-Feed.",
  );
  assert.equal(
    translateCheck("Price in line with the market: compared with 18 listings of the same product on eBay.", "de"),
    "Preis im Marktrahmen: verglichen mit 18 Angeboten desselben Produkts auf eBay.",
  );
  assert.equal(translateCheck("Seller account is 1 day old.", "de"), "Das Verkäuferkonto ist 1 Tag alt.");
  assert.equal(translateCheck("42.50 EUR below the typical new price", "de"), "42.50 EUR unter dem typischen Neupreis");
  assert.equal(translateCheck("SigPath only buys what it could price-check. There weren't enough used listings to compare its price with.", "de"),
    "SigPath kauft nur, was es preislich prüfen konnte. Es gab nicht genug gebrauchte Angebote, um den Preis zu vergleichen.");
  assert.equal(translateWhere("on eBay", "de"), "auf eBay");
  const english = "Seller account is 3 days old.";
  assert.equal(translateCheck(english, "en"), english);
  assert.equal(translateCheck("Something new the checks say", "de"), "Something new the checks say", "unknown: unchanged, never guessed");
});

test("the language choice: German only when chosen, every key in both languages", () => {
  assert.equal(pickLang("de"), "de");
  assert.equal(pickLang("en"), "en");
  assert.equal(pickLang(undefined), "en");
  assert.equal(pickLang("fr"), "en");
  const keys = (o: object, p = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  assert.deepEqual(keys(MESSAGES.de).sort(), keys(MESSAGES.en).sort());
  assert.equal(MESSAGES.de.cart.proceed(2), "Zur Kasse · 2 Artikel in USDC →");
  assert.notEqual(MESSAGES.de.home.sub, MESSAGES.en.home.sub);
});
