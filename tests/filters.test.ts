import { test } from "node:test";
import assert from "node:assert";
import { applyFilters, euros, filterHref, isFiltered, NO_FILTERS, parseFilters } from "../lib/marketplace/filters";
import type { CheckLabel } from "../lib/marketplace/label";
import type { Identity } from "../lib/marketplace/identity";
import type { Listing } from "../lib/marketplace/types";

/**
 * The search page's filters: read from the address, they narrow and reorder
 * what is shown, and never change a verdict.
 */

const at = (id: string, euro: number, over: Partial<Listing> = {}): Listing => ({
  id,
  source: "ebay",
  title: id,
  url: `https://ebay.de/${id}`,
  price: { amount: euro * 100, currency: "EUR" },
  condition: "new",
  seller: { handle: id },
  ...over,
});

const listings = [
  at("checked-new", 150),
  at("checked-used", 120, { condition: "used" }),
  at("refurb", 160, { condition: "refurbished" }),
  at("ali", 20, { source: "aliexpress" }),
  at("case", 15),
  at("broken", 60, { condition: "used" }),
];
const CHECKED = new Set(["checked-new", "checked-used"]);
const labelOf = (l: Listing): CheckLabel => ({ verdict: CHECKED.has(l.id) ? "checked" : "unchecked", headline: "", points: [] });
const identities: Record<string, Identity> = {
  "ebay:case": { kind: "accessory" },
  "ebay:broken": { kind: "parts" },
};
const ids = (f: Parameters<typeof applyFilters>[1]) => applyFilters(listings, f, labelOf, identities).map((l) => l.id);

test("prices as people type them", () => {
  assert.strictEqual(euros("150"), 15000);
  assert.strictEqual(euros("149,99"), 14999);
  assert.strictEqual(euros("1.200"), 120000);
  assert.strictEqual(euros("1 200,50 €"), 120050);
  assert.strictEqual(euros("12.5"), 1250);
  for (const bad of ["", "abc", "-5", undefined]) assert.strictEqual(euros(bad), null, String(bad));
});

test("the address becomes filters, and anything odd falls back to none", () => {
  assert.deepStrictEqual(parseFilters({}), NO_FILTERS);
  assert.ok(!isFiltered(parseFilters({ cond: "mint", sort: "random", market: "<script>" })));
  const f = parseFilters({ cond: "used", market: "eBay", min: "300", max: "100", checked: "1", products: "1", sort: "price-desc" });
  assert.deepStrictEqual(f, { condition: "used", market: "ebay", min: 10000, max: 30000, checkedOnly: true, productsOnly: true, sort: "price-desc" });
});

test("each filter narrows what is shown, in the search's own order", () => {
  assert.deepStrictEqual(ids(NO_FILTERS), listings.map((l) => l.id), "nothing filtered: all, as they came");
  assert.deepStrictEqual(ids({ ...NO_FILTERS, condition: "used" }), ["checked-used", "broken"]);
  assert.deepStrictEqual(ids({ ...NO_FILTERS, condition: "refurbished" }), ["refurb"]);
  assert.deepStrictEqual(ids({ ...NO_FILTERS, market: "aliexpress" }), ["ali"]);
  assert.deepStrictEqual(ids({ ...NO_FILTERS, checkedOnly: true }), ["checked-new", "checked-used"]);
  assert.deepStrictEqual(ids({ ...NO_FILTERS, productsOnly: true }), ["checked-new", "checked-used", "refurb", "ali"]);
  assert.deepStrictEqual(ids({ ...NO_FILTERS, min: 10000, max: 15000 }), ["checked-new", "checked-used"]);
});

test("sorting by price, both ways, after filtering", () => {
  assert.deepStrictEqual(ids({ ...NO_FILTERS, sort: "price", productsOnly: true }), ["ali", "checked-used", "checked-new", "refurb"]);
  assert.deepStrictEqual(ids({ ...NO_FILTERS, sort: "price-desc", condition: "used" }), ["checked-used", "broken"]);
});

test("links keep the filters, and can change one", () => {
  const f = parseFilters({ cond: "used", max: "149.5", sort: "price" });
  assert.strictEqual(filterHref("Switch OLED", f), "/search?q=Switch+OLED&cond=used&max=149.5&sort=price");
  assert.strictEqual(filterHref("Switch OLED", f, { checked: "1" }), "/search?q=Switch+OLED&cond=used&max=149.5&sort=price&checked=1");
  assert.strictEqual(filterHref("Switch OLED", { ...f, checkedOnly: true }, { checked: "" }), "/search?q=Switch+OLED&cond=used&max=149.5&sort=price");
});

test("a repeat of a recent search is answered from what the marketplace said, a failure never is", async () => {
  const { cachedSources, clearSearchCache, SEARCH_CACHE_SECS } = await import("../lib/marketplace/search-cache");
  clearSearchCache();
  let asked = 0;
  let status: "ok" | "error" = "ok";
  const source = { id: "ebay" as const, search: async () => (asked++, { source: "ebay" as const, status, listings: [] }) };
  let t = 1_000_000;
  const [s] = cachedSources([source], () => t);
  await s.search("Switch OLED", { limit: 20 });
  await s.search("switch oled ", { limit: 20 });
  assert.strictEqual(asked, 1, "the same search, asked once");
  await s.search("Switch OLED", { limit: 50 });
  assert.strictEqual(asked, 2, "a different size is a different search");
  t += SEARCH_CACHE_SECS * 1000;
  await s.search("Switch OLED", { limit: 20 });
  assert.strictEqual(asked, 3, "after three minutes, asked again");
  status = "error";
  await s.search("PS5", {});
  await s.search("PS5", {});
  assert.strictEqual(asked, 5, "a failed answer isn't kept");
  clearSearchCache();
});
