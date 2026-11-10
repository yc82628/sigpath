import { test } from "node:test";
import assert from "node:assert";
import { activeCount, applyFilters, euros, facets, filterHref, isFiltered, modelKey, NO_FILTERS, parseFilters } from "../lib/marketplace/filters";
import { identify } from "../lib/marketplace/identity";
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
  assert.deepStrictEqual(f, { ...NO_FILTERS, condition: "used", market: "ebay", min: 10000, max: 30000, checkedOnly: true, productsOnly: true, sort: "price-desc" });
  const g = parseFilters({ model: "pro-max", storage: "256", ram: "16", gen: "3", ship: "free" });
  assert.deepStrictEqual(g, { ...NO_FILTERS, model: "pro-max", storage: 256, ram: 16, gen: 3, freeShipping: true });
  const bad = parseFilters({ model: "Pro Max<", storage: "0", ram: "x", gen: "1000", ship: "yes" });
  assert.deepStrictEqual(bad, NO_FILTERS, "odd specs fall back to none");
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

test("the price check's market is shared between shoppers for half an hour, through the database", async () => {
  const { sharedSources, SHARED_CACHE_SECS } = await import("../lib/marketplace/search-cache");
  const db = new Map<string, string>();
  const sets: unknown[][] = [];
  const kv = {
    command: async <T>(args: (string | number)[]): Promise<T> => {
      if (args[0] === "GET") return (db.get(String(args[1])) ?? null) as T;
      sets.push(args);
      db.set(String(args[1]), String(args[2]));
      return "OK" as T;
    },
    pipeline: async () => [],
  };
  let asked = 0;
  let status: "ok" | "error" = "ok";
  const source = { id: "ebay" as const, search: async () => (asked++, { source: "ebay" as const, status, listings: [] }) };
  // Two server instances, one database.
  const [a] = sharedSources([source], kv);
  const [b] = sharedSources([source], kv);
  await a.search("AirPods Pro 2", { limit: 50, currency: "EUR" });
  const r = await b.search("airpods pro 2", { limit: 50, currency: "EUR" });
  assert.strictEqual(asked, 1, "the second shopper's check costs no eBay search");
  assert.strictEqual(r.status, "ok");
  assert.deepStrictEqual(sets[0].slice(3), ["EX", SHARED_CACHE_SECS], "kept with an expiry");
  status = "error";
  await a.search("PS5", {});
  await b.search("PS5", {});
  assert.strictEqual(asked, 3, "a failed answer isn't shared");

  const broken = { command: async () => { throw new Error("down"); }, pipeline: async () => [] };
  status = "ok";
  const [c] = sharedSources([source], broken);
  assert.strictEqual((await c.search("Switch", {})).status, "ok", "a database that fails never fails the check");
  assert.strictEqual(sharedSources([source], null)[0], source, "no database: asked live");
});

/** An "iPhone 15" search: four phones, one case, the specs read from each title as the page does. */
const phones = [
  at("p128", 600, { title: "Apple iPhone 15 Pro 128GB Titan", shipping: { amount: 0, currency: "EUR" } }),
  at("p256", 700, { title: "Apple iPhone 15 Pro 256 GB Schwarz" }),
  at("pm256", 900, { title: "iPhone 15 Pro Max 256GB", condition: "used" }),
  at("b128", 450, { title: "Apple iPhone 15 128GB Blau", shipping: { amount: 0, currency: "EUR" } }),
  at("hulle", 15, { title: "Hülle für iPhone 15 Pro" }),
];
const phoneIds: Record<string, ReturnType<typeof identify>> = Object.fromEntries(phones.map((l) => [`ebay:${l.id}`, identify(l.title, "iPhone 15")]));
const phoneChecked = (l: Listing): CheckLabel => ({ verdict: l.id === "hulle" || l.id === "p128" ? "unchecked" : "checked", headline: "", points: [] });
const phonesShown = (f: Parameters<typeof applyFilters>[1]) => applyFilters(phones, f, phoneChecked, phoneIds).map((l) => l.id);

test("the model, as people say it, from the words after the searched name", () => {
  assert.strictEqual(modelKey(phoneIds["ebay:pm256"]), "pro-max", "not max-pro");
  assert.strictEqual(modelKey(phoneIds["ebay:p128"]), "pro");
  assert.strictEqual(modelKey(phoneIds["ebay:b128"]), "base");
  assert.strictEqual(modelKey(phoneIds["ebay:hulle"]), null, "an accessory has no model to pick");
  assert.strictEqual(modelKey(undefined), null);
});

test("model, storage and free shipping narrow to exactly that; a listing that doesn't say never matches", () => {
  assert.deepStrictEqual(phonesShown({ ...NO_FILTERS, model: "pro" }), ["p128", "p256"]);
  assert.deepStrictEqual(phonesShown({ ...NO_FILTERS, storage: 256 }), ["p256", "pm256"]);
  assert.deepStrictEqual(phonesShown({ ...NO_FILTERS, model: "pro", storage: 256 }), ["p256"]);
  assert.deepStrictEqual(phonesShown({ ...NO_FILTERS, freeShipping: true }), ["p128", "b128"]);
  assert.deepStrictEqual(phonesShown({ ...NO_FILTERS, ram: 8 }), [], "no title states RAM");
  assert.strictEqual(activeCount({ ...NO_FILTERS, model: "pro", storage: 256, min: 100, max: 500, sort: "price" }), 3, "a price range is one filter, sort none");
  assert.strictEqual(filterHref("iPhone 15", { ...NO_FILTERS, model: "pro-max", storage: 256, freeShipping: true }), "/search?q=iPhone+15&ship=free&model=pro-max&storage=256");
});

test("each choice counts what it would show, with the other filters applied", () => {
  const all = facets(phones, NO_FILTERS, phoneChecked, phoneIds);
  assert.deepStrictEqual(all.condition, { any: 5, new: 4, refurbished: 0, used: 1 });
  assert.deepStrictEqual(all.storage, [{ value: 128, count: 2 }, { value: 256, count: 2 }]);
  assert.deepStrictEqual(all.ram, [], "a spec nobody states isn't offered");
  assert.strictEqual(all.freeShipping, 2);
  assert.deepStrictEqual(
    all.models.map((c) => [c.key, c.count, c.from?.amount ?? null, c.storages]),
    [
      ["pro", 2, 70000, [128, 256]],
      ["pro-max", 1, 90000, [256]],
      ["base", 1, 45000, [128]],
    ],
    "biggest first; 'from' is the cheapest checked offer, so not the unchecked 600 €",
  );
  const used = facets(phones, { ...NO_FILTERS, condition: "used" }, phoneChecked, phoneIds);
  assert.strictEqual(used.condition.new, 4, "the condition's own counts ignore the condition chosen");
  assert.deepStrictEqual(used.storage, [], "among used ones, only one size: nothing to choose");
  assert.deepStrictEqual(used.models, [], "one model is no choice");
  const pro = facets(phones, { ...NO_FILTERS, model: "pro" }, phoneChecked, phoneIds);
  assert.strictEqual(pro.models.length, 3, "the cards still show every model while one is picked");
});
