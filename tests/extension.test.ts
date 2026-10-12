import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSeen, SeenStore, seenListing, SEEN_MAX_AGE_MS } from "../lib/extension/seen";
import { FileTable } from "../lib/kv/table";
import { AmazonSeenSource } from "../lib/marketplace/sources/amazon-seen";
import { searchAll } from "../lib/marketplace/search";
import { StubSource } from "../lib/marketplace/sources/stub";
import { withLabels } from "../lib/marketplace/label";
import { SITE_ONLY } from "../lib/marketplace/site-only";

/**
 * Amazon prices seen by shoppers with the extension: kept only when well
 * formed, never trusted (never checked, never in the median), linked to
 * Amazon's own page, and only the shops in the manifest.
 */

const store = () => new SeenStore(new FileTable(join(mkdtempSync(join(tmpdir(), "seen-")), "seen.json")));
const item = (asin: string, title: string, amount = 19900, extra: Record<string, unknown> = {}) => ({
  asin,
  title,
  price: { amount, currency: "EUR" },
  imageUrl: "https://m.media-amazon.com/images/I/x.jpg",
  ...extra,
});

test("a sighting is kept only when it's a plausible Amazon.de product", () => {
  const now = 1;
  assert.ok(cleanSeen(item("B0CHWRXH8B", "Apple AirPods Pro 2"), now));
  assert.equal(cleanSeen(item("not-an-asin", "x x x"), now), null);
  assert.equal(cleanSeen(item("B0CHWRXH8B", "Apple AirPods Pro 2", 19900, { price: { amount: 19900, currency: "USD" } }), now), null);
  assert.equal(cleanSeen(item("B0CHWRXH8B", "Apple AirPods Pro 2", 10), now), null, "10 cents is no price");
  assert.equal(cleanSeen(item("B0CHWRXH8B", "Apple AirPods Pro 2", 19900, { imageUrl: "https://evil.example/x.jpg" }), now)?.imageUrl, undefined);
  assert.equal(cleanSeen(null, now), null);
});

test("search finds this week's sightings by every word, newest first; older ones are gone", async () => {
  const s = store();
  const t0 = 1_000_000_000_000;
  await s.record([item("B000000001", "Apple AirPods Pro 2 MagSafe")], t0);
  await s.record([item("B000000002", "Apple AirPods Pro 2 USB-C"), item("B000000003", "Sony WH-1000XM5")], t0 + 1000);
  assert.deepEqual((await s.search("airpods pro", t0 + 2000)).map((x) => x.asin), ["B000000002", "B000000001"]);
  assert.deepEqual((await s.search("airpods sony", t0 + 2000)).map((x) => x.asin), []);
  assert.deepEqual((await s.search("airpods", t0 + SEEN_MAX_AGE_MS + 500)).map((x) => x.asin), ["B000000002"]);
});

test("a sighting is Amazon's own product page, tagged; never checked, never in the median", async () => {
  const l = seenListing({ asin: "B000000001", title: "ThinkPad X1 Carbon", price: { amount: 9900, currency: "EUR" }, seenAt: 5 }, "sigpath-21");
  assert.equal(l.url, "https://www.amazon.de/dp/B000000001?tag=sigpath-21");
  assert.equal(l.affiliate, true);
  assert.equal(seenListing({ ...l, asin: "B000000001", seenAt: 5 } as never, null).url, "https://www.amazon.de/dp/B000000001");

  const s = store();
  await s.record([item("B000000009", "ThinkPad X1 cheap", 1000)], Date.now());
  const r = withLabels(await searchAll("ThinkPad X1", [new StubSource("EUR", 0), new AmazonSeenSource({}, s)], { limit: 25 }));
  const seen = r.listings.find((x) => x.source === "amazon")!;
  assert.ok(seen, "the sighting shows in the search");
  assert.notEqual(seen.check.verdict, "checked");
  assert.ok(r.analysis.excludedFromComparison.includes("amazon"), "kept out of the median");
  assert.ok(!r.bestCheckedDeals.some((d) => d.listing.startsWith("amazon:")));
  assert.ok(r.linkOut.some((t) => t.id === "amazon"), "Amazon's own search link stays: sightings aren't a live source");
  assert.ok(SITE_ONLY.has("amazon"), "never passed to the paid API or the assistant");
});

test("the extension runs by itself only on the listed shops, elsewhere only when asked, and talks only to SigPath", () => {
  const m = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
  // activeTab + scripting: "Check this page" reaches only the open tab, only when the shopper clicks it.
  assert.deepEqual(m.permissions, ["storage", "activeTab", "scripting"]);
  assert.deepEqual(m.host_permissions, ["https://sigpath.vercel.app/*"], "SigPath only, never the shopper's own machine");
  assert.deepEqual(m.content_scripts[0].matches, [
    "https://www.amazon.de/*",
    "https://www.amazon.com/*",
    "https://www.amazon.co.uk/*",
    "https://www.amazon.fr/*",
    "https://www.amazon.it/*",
    "https://www.amazon.es/*",
    "https://www.amazon.nl/*",
    "https://*.aliexpress.com/*",
    "https://www.otto.de/*",
    "https://www.mediamarkt.de/*",
    "https://www.saturn.de/*",
  ]);
});
