import { test } from "node:test";
import assert from "node:assert";
import { agentCheck, gatewayAuthorised } from "../lib/agents/check";
import { CHECKED_MEANS, withLabels } from "../lib/marketplace/label";
import { searchAll } from "../lib/marketplace/search";
import { StubSource } from "../lib/marketplace/sources/stub";
import type { MarketplaceSource } from "../lib/marketplace/sources/types";

/** The real pipeline over the demo feed, which always contains scam bait. */
async function check(q: string, sources: MarketplaceSource[] = [new StubSource()]) {
  return agentCheck(q, withLabels(await searchAll(q, sources, { limit: 20 })));
}

test("agent check: best deals are checked listings, and the bait is flagged", async () => {
  const c = await check("ThinkPad X1");
  assert.ok(c.bestChecked.length >= 1);
  for (const d of c.bestChecked) assert.strictEqual(d.listing.verdict, "checked");
  const bait = c.listings.find((l) => l.url.endsWith("/used-bait"));
  assert.ok(bait, "the demo feed's underpriced listing is present");
  assert.strictEqual(bait.verdict, "caution");
  assert.ok(bait.reasons.length > 0, "a warning always says why");
});

test("agent check: counts add up and the caveat travels with the answer", async () => {
  const c = await check("AirPods Pro");
  assert.strictEqual(c.counts.checked + c.counts.caution + c.counts.unchecked, c.listings.length);
  assert.strictEqual(c.checkedMeans, CHECKED_MEANS);
  assert.deepStrictEqual(c.searched, ["Demo"]);
});

test("agent check: prices are display strings with shipping included", async () => {
  const c = await check("Nike Air Max 90");
  for (const l of c.listings) assert.match(l.total, /^\d+\.\d{2} [A-Z]{3}$/);
});

test("agent check: a marketplace that did not answer is named, not hidden", async () => {
  const failing: MarketplaceSource = {
    id: "ebay",
    async search() {
      return { source: "ebay", status: "timeout", listings: [] };
    },
  } as MarketplaceSource;
  const c = await check("ThinkPad X1", [new StubSource(), failing]);
  assert.deepStrictEqual(c.notSearched, [{ marketplace: "eBay", status: "timeout" }]);
});

test("gateway key: open without one configured, exact match with one", () => {
  assert.strictEqual(gatewayAuthorised(null, undefined), true);
  assert.strictEqual(gatewayAuthorised(null, ""), true);
  const key = "k".repeat(40);
  assert.strictEqual(gatewayAuthorised(key, key), true);
  assert.strictEqual(gatewayAuthorised(null, key), false);
  assert.strictEqual(gatewayAuthorised("k".repeat(39), key), false);
  assert.strictEqual(gatewayAuthorised("x".repeat(40), key), false);
});
