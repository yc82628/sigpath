import { test } from "node:test";
import assert from "node:assert";
import { ETSY_NOTICE, etsyOn, withoutEtsy } from "../lib/marketplace/etsy-terms";
import { checkoutEligibility } from "../lib/checkout/eligibility";
import { SearchInput } from "../lib/assistant/search-tool";
import { API_MARKETPLACES } from "../lib/api/verification";
import type { LabelledSearch } from "../lib/marketplace/labelled-search";
import type { Listing } from "../lib/marketplace/types";

// The rules from Etsy's API Terms of Use (etsy.com/legal/api) that SigPath keeps in code.

test("the notice is Etsy's exact wording, shown only when Etsy is on", () => {
  assert.equal(
    ETSY_NOTICE,
    "The term 'Etsy' is a trademark of Etsy, Inc. This Application uses Etsy's API, but is not endorsed or certified by Etsy.",
  );
  assert.equal(etsyOn({}), false);
  assert.equal(etsyOn({ ETSY_KEYSTRING: "k" }), false, "both keys are needed, as for the search");
  assert.equal(etsyOn({ ETSY_KEYSTRING: "k", ETSY_SHARED_SECRET: "s" }), true);
});

test("Etsy listings never reach the paid API or the AI assistant", () => {
  const result = {
    listings: [{ source: "ebay", id: "1" }, { source: "etsy", id: "2" }],
    sources: [{ source: "ebay", status: "ok" }, { source: "etsy", status: "ok" }],
    bestCheckedDeals: [{ listing: "ebay:1" }, { listing: "etsy:2" }],
  } as unknown as LabelledSearch;
  const out = withoutEtsy(result);
  assert.deepEqual(out.listings.map((l) => l.source), ["ebay"]);
  assert.deepEqual(out.sources.map((s) => s.source), ["ebay"]);
  assert.deepEqual(out.bestCheckedDeals.map((d) => d.listing), ["ebay:1"]);
  assert.equal(result.listings.length, 2, "the shopper's own search keeps them");

  assert.equal(SearchInput.safeParse({ query: "mug", marketplaces: ["etsy"] }).success, false, "Ai-chan can't ask for Etsy");
  assert.ok(!(API_MARKETPLACES as readonly string[]).includes("etsy"), "the paid seller API doesn't answer for Etsy shops");
});

test("an Etsy listing is never checked out through SigPath, even if every check passed", () => {
  const etsy: Listing = {
    id: "2", source: "etsy", title: "t", url: "https://www.etsy.com/listing/2", condition: "new", seller: { handle: "shop:1" },
    price: { amount: 10000, currency: "EUR" }, shipping: { amount: 500, currency: "EUR" },
  };
  const r = checkoutEligibility(etsy, [], { checked: true });
  assert.equal(r.eligible, false);
  assert.match(!r.eligible ? r.reason : "", /bought on Etsy/);
});
