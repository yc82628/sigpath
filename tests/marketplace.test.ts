import { test } from "node:test";
import assert from "node:assert";
import { analyse, median, MIN_SAMPLE, UNDERPRICED_RATIO } from "../lib/marketplace/anomaly";
import { searchAll } from "../lib/marketplace/search";
import { StubSource } from "../lib/marketplace/sources/stub";
import { EbaySource, toMinorUnits } from "../lib/marketplace/sources/ebay";
import { totalPrice, type Listing, type SourceResult } from "../lib/marketplace/types";
import type { MarketplaceSource } from "../lib/marketplace/sources/types";
import { MARKETPLACES, linkOutTargets } from "../lib/marketplace/registry";
import { AmazonSource, signPaapiRequest } from "../lib/marketplace/sources/amazon";
import { FeedSource, parseDelimited, feedPriceToMinorUnits } from "../lib/marketplace/sources/feed";
import { EtsySource, etsyMoneyToMinorUnits, etsyCondition } from "../lib/marketplace/sources/etsy";
import { defaultSources } from "../lib/marketplace/sources";

/**
 * The property these tests exist to protect:
 *
 *   A FALSE SCAM FLAG IS WORSE THAN A MISSED SCAM.
 *
 * A missed scam leaves the buyer where they already were. A false flag actively
 * misinforms them and defames a seller, so every ambiguous case must resolve to
 * silence.
 */

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "l1",
    source: "stub",
    title: "thing",
    url: "https://example.invalid/1",
    price: { amount: 10000, currency: "EUR" },
    condition: "new",
    seller: { handle: "seller_a" },
    ...over,
  };
}

/** n honest listings all at the same price, so the median is unambiguous. */
function honest(n: number, amount = 10000): Listing[] {
  return Array.from({ length: n }, (_, i) =>
    listing({ id: `ok-${i}`, price: { amount, currency: "EUR" }, seller: { handle: `s${i}` } }),
  );
}

function ok(listings: Listing[]): SourceResult {
  return { source: "stub", status: "ok", listings };
}

// ---------------------------------------------------------------------------
// Incomplete coverage must block the price comparison
// ---------------------------------------------------------------------------

test("a failed source withholds the price verdict entirely", () => {
  // THE CENTRAL RULE. If the expensive marketplace times out and only the cheap
  // one answers, the median drops and ordinary listings start reading as
  // underpriced — the check would be most confident exactly when it is least
  // entitled to be. Same class of bug as the rate-limited footprint collector
  // whose score was computed from the signals that happened to survive.
  const a = analyse([
    ok(honest(20)),
    { source: "ebay", status: "timeout", listings: [], detail: "8s" },
  ]);

  assert.equal(a.status, "incomplete_coverage");
  assert.equal(a.median, undefined, "no median may be published on a biased sample");
  assert.ok(!a.flags.some((f) => f.kind === "underpriced"));
  assert.match(a.reason ?? "", /biased|did not respond/i);
});

test("an unconfigured source does NOT block the comparison", () => {
  // An unconfigured source is not missing data — it is a marketplace this
  // deployment does not search, which skews a median no more than one we never
  // integrated. Treating it as degraded (the first version of this rule) meant
  // the price check could not run until every planned source had credentials:
  // useless in development, and wrong in principle.
  const a = analyse([
    ok([...honest(10), listing({ id: "bait", price: { amount: 2000, currency: "EUR" } })]),
    { source: "ebay", status: "not_configured", listings: [] },
  ]);
  assert.equal(a.status, "ok");
  assert.deepEqual(a.notConfigured, ["ebay"]);
  assert.ok(a.flags.some((f) => f.listingId === "bait" && f.kind === "underpriced"));
});

test("a single-source median does not claim to be cross-marketplace", () => {
  // Overstating the evidence is its own kind of dishonesty. With one source the
  // flag must name that source rather than implying breadth it does not have.
  const a = analyse([
    ok([...honest(10), listing({ id: "bait", price: { amount: 2000, currency: "EUR" } })]),
    { source: "ebay", status: "not_configured", listings: [] },
  ]);
  const flag = a.flags.find((f) => f.kind === "underpriced");
  assert.deepEqual(a.coverage, ["stub"]);
  assert.match(flag!.message, /on stub/);
  assert.ok(!/across/.test(flag!.message), "must not claim breadth it does not have");
});

test("a multi-source median does say across marketplaces", () => {
  const a = analyse([
    ok(honest(6)),
    { source: "ebay", status: "ok", listings: honest(6).map((l, i) => ({ ...l, id: `e${i}`, source: "ebay" as const })) },
    ok([listing({ id: "bait", price: { amount: 2000, currency: "EUR" } })]),
  ]);
  const flag = a.flags.find((f) => f.kind === "underpriced");
  assert.match(flag!.message, /across 3 marketplaces/);
});

test("the degraded sources are always named", () => {
  const a = analyse([
    ok(honest(20)),
    { source: "ebay", status: "rate_limited", listings: [], detail: "429" },
  ]);
  assert.deepEqual(
    a.degraded.map((d) => d.source),
    ["ebay"],
  );
});

test("coverage-independent flags still run when coverage is incomplete", () => {
  // A shared photograph is true whether or not a third marketplace answered.
  // Withholding it would be over-correcting: the rule is about the SAMPLE, not
  // about every observation.
  const a = analyse([
    ok([
      listing({ id: "x", imageHash: "same", seller: { handle: "a" } }),
      listing({ id: "y", imageHash: "same", seller: { handle: "b" } }),
    ]),
    { source: "ebay", status: "error", listings: [], detail: "boom" },
  ]);
  assert.equal(a.status, "incomplete_coverage");
  assert.equal(a.flags.filter((f) => f.kind === "duplicate_image").length, 2);
});

// ---------------------------------------------------------------------------
// Sample size
// ---------------------------------------------------------------------------

test("too few listings yields no median", () => {
  const a = analyse([ok(honest(MIN_SAMPLE - 1))]);
  assert.equal(a.status, "insufficient_sample");
  assert.equal(a.median, undefined);
});

test("a lone very cheap listing in a tiny sample is not flagged", () => {
  // With three listings the 'median' is one price with extra steps, and the
  // outlier itself drags it. Flagging here would be guessing.
  const a = analyse([ok([...honest(2), listing({ id: "cheap", price: { amount: 1000, currency: "EUR" } })])]);
  assert.equal(a.status, "insufficient_sample");
  assert.equal(a.flags.length, 0);
});

// ---------------------------------------------------------------------------
// The actual detection
// ---------------------------------------------------------------------------

test("a drastically underpriced listing is flagged once coverage is complete", () => {
  const a = analyse([ok([...honest(10), listing({ id: "bait", price: { amount: 2000, currency: "EUR" } })])]);
  assert.equal(a.status, "ok");
  assert.equal(a.median, 10000);
  assert.ok(a.flags.some((f) => f.listingId === "bait" && f.kind === "underpriced"));
});

test("a merely cheap listing is not flagged", () => {
  // 60% of median is clearance, damage or a hurry — not evidence of anything.
  const justUnder = Math.round(10000 * (UNDERPRICED_RATIO + 0.1));
  const a = analyse([ok([...honest(10), listing({ id: "cheapish", price: { amount: justUnder, currency: "EUR" } })])]);
  assert.equal(a.status, "ok");
  assert.ok(!a.flags.some((f) => f.listingId === "cheapish"));
});

test("shipping counts toward the price a buyer actually pays", () => {
  // A 20.00 item with 90.00 shipping is not underpriced, and treating the
  // headline price as the total is how a listing gets flagged for being cheap
  // when it is not.
  const a = analyse([
    ok([
      ...honest(10),
      listing({
        id: "shipped",
        price: { amount: 2000, currency: "EUR" },
        shipping: { amount: 9000, currency: "EUR" },
      }),
    ]),
  ]);
  assert.ok(!a.flags.some((f) => f.listingId === "shipped"));
});

test("used listings are not compared against new ones", () => {
  // A used unit at half the price of a new one is a used unit.
  const a = analyse([ok([...honest(10), listing({ id: "worn", condition: "used", price: { amount: 2000, currency: "EUR" } })])]);
  assert.ok(!a.flags.some((f) => f.listingId === "worn"));
});

test("a listing in another currency is set aside, not converted", () => {
  // Comparing 2000 JPY against a EUR median would flag every Japanese listing.
  // No exchange rate is available here, so the honest move is to exclude it.
  const a = analyse([ok([...honest(10), listing({ id: "yen", price: { amount: 2000, currency: "JPY" } })])]);
  assert.equal(a.currency, "EUR");
  assert.ok(!a.flags.some((f) => f.listingId === "yen"));
});

test("one seller cross-posting their own item is not a duplicate", () => {
  // That is the entire premise of this site.
  const a = analyse([
    ok([
      listing({ id: "a", imageHash: "same", source: "ebay", seller: { handle: "me" } }),
      listing({ id: "b", imageHash: "same", source: "stub", seller: { handle: "me" } }),
    ]),
  ]);
  assert.equal(a.flags.filter((f) => f.kind === "duplicate_image").length, 0);
});

test("two accounts on the SAME marketplace sharing a photo is flagged", () => {
  // Unambiguous: two handles on one site are two accounts.
  const a = analyse([
    ok([
      listing({ id: "a", imageHash: "same", source: "ebay", seller: { handle: "one" } }),
      listing({ id: "b", imageHash: "same", source: "ebay", seller: { handle: "two" } }),
    ]),
  ]);
  assert.equal(a.flags.filter((f) => f.kind === "duplicate_image").length, 2);
});

test("different handles on DIFFERENT marketplaces are not accused", () => {
  // This is the case the aggregator genuinely cannot resolve on its own. A
  // seller trading as `bobsdeals` on one site and `bob_deals` on another is
  // indistinguishable from two accounts sharing a stolen photo, and guessing
  // wrong here defames an ordinary cross-poster. Resolving it needs a proven
  // identity link between the two accounts — which is what the verification
  // half of this product exists to supply.
  const a = analyse([
    ok([
      listing({ id: "a", imageHash: "same", source: "ebay", seller: { handle: "bobsdeals" } }),
      listing({ id: "b", imageHash: "same", source: "stub", seller: { handle: "bob_deals" } }),
    ]),
  ]);
  assert.equal(a.flags.filter((f) => f.kind === "duplicate_image").length, 0);
});

test("handle comparison ignores case", () => {
  const a = analyse([
    ok([
      listing({ id: "a", imageHash: "same", source: "ebay", seller: { handle: "Seller" } }),
      listing({ id: "b", imageHash: "same", source: "ebay", seller: { handle: "seller" } }),
    ]),
  ]);
  assert.equal(a.flags.filter((f) => f.kind === "duplicate_image").length, 0);
});

test("a brand-new seller account is flagged", () => {
  const a = analyse([
    ok([listing({ id: "fresh", seller: { handle: "new", memberSince: Math.floor(Date.now() / 1000) - 86400 } })]),
  ]);
  assert.ok(a.flags.some((f) => f.listingId === "fresh" && f.kind === "new_account"));
});

test("median is integer and does not drift on even-length sets", () => {
  assert.equal(median([100, 200, 300]), 200);
  assert.equal(median([100, 200, 300, 401]), 250);
  assert.ok(Number.isInteger(median([1, 2, 3, 4])));
});

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

test("a source that throws becomes a typed failure, not a crash", async () => {
  const exploding: MarketplaceSource = {
    id: "amazon",
    search: async () => {
      throw new Error("kaboom");
    },
  };
  const r = await searchAll("thinkpad", [new StubSource(), exploding]);

  assert.ok(r.listings.length > 0, "the working source still contributes");
  const broken = r.sources.find((s) => s.source === "amazon");
  assert.equal(broken?.status, "error");
  assert.match(broken?.detail ?? "", /kaboom/);
  // And the failure must reach the analysis, not be swallowed by the merge.
  assert.equal(r.analysis.status, "incomplete_coverage");
});

test("results are ordered by what the buyer actually pays", async () => {
  const r = await searchAll("camera", [new StubSource()]);
  const totals = r.listings.map((l) => totalPrice(l).amount);
  assert.deepEqual(totals, [...totals].sort((a, b) => a - b));
});

test("the stub feed is deterministic", async () => {
  const a = await searchAll("thinkpad x1", [new StubSource()]);
  const b = await searchAll("thinkpad x1", [new StubSource()]);
  assert.deepEqual(
    a.listings.map((l) => [l.id, l.price.amount]),
    b.listings.map((l) => [l.id, l.price.amount]),
  );
});

test("different queries produce different prices", async () => {
  const a = await searchAll("thinkpad x1", [new StubSource()]);
  const b = await searchAll("nikon f3", [new StubSource()]);
  assert.notDeepEqual(
    a.listings.map((l) => l.price.amount),
    b.listings.map((l) => l.price.amount),
  );
});

test("the stub feed exercises both detections end to end", async () => {
  // A feed that only ever looks healthy cannot demonstrate a check meant to
  // catch unhealthy things.
  const r = await searchAll("thinkpad x1", [new StubSource()]);
  assert.equal(r.analysis.status, "ok", r.analysis.reason);
  assert.ok(r.analysis.flags.some((f) => f.kind === "underpriced"), "no underpriced flag");
  assert.ok(r.analysis.flags.some((f) => f.kind === "duplicate_image"), "no duplicate flag");
  assert.ok(r.analysis.flags.some((f) => f.kind === "new_account"), "no new-account flag");
});

test("an empty query searches nothing", async () => {
  const r = await searchAll("   ", [new StubSource()]);
  assert.equal(r.listings.length, 0);
  assert.equal(r.sources.length, 0);
});

// ---------------------------------------------------------------------------
// eBay source
// ---------------------------------------------------------------------------

test("eBay reports not_configured rather than failing, and never throws", async () => {
  const r = await new EbaySource({}).search("thinkpad");
  assert.equal(r.status, "not_configured");
  assert.deepEqual(r.listings, []);
  assert.match(r.detail ?? "", /EBAY_CLIENT_ID/);
});

test("prices are parsed to integer minor units", () => {
  assert.equal(toMinorUnits("19.99"), 1999);
  assert.equal(toMinorUnits("19,9"), 1990);
  assert.equal(toMinorUnits("200"), 20000);
  assert.equal(toMinorUnits("0.05"), 5);
  // Anything unparseable must be null so the listing is DROPPED rather than
  // guessed at — a wrong price becomes a wrong median for every other listing.
  assert.equal(toMinorUnits("about 20"), null);
  assert.equal(toMinorUnits(""), null);
});

test("an eBay item with an unparseable price is dropped, not guessed", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        itemSummaries: [
          { itemId: "1", itemWebUrl: "https://ebay.invalid/1", price: { value: "10.00", currency: "EUR" } },
          { itemId: "2", itemWebUrl: "https://ebay.invalid/2", price: { value: "N/A", currency: "EUR" } },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const r = await new EbaySource(
    { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret" },
    fetchImpl,
  ).search("thinkpad");

  assert.equal(r.status, "ok");
  assert.equal(r.listings.length, 1);
  assert.equal(r.listings[0].id, "1");
});

test("an eBay 429 is rate_limited, distinct from an error", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
    }
    return new Response("slow down", { status: 429 });
  }) as unknown as typeof fetch;

  const r = await new EbaySource({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "s" }, fetchImpl).search("x");
  assert.equal(r.status, "rate_limited");
});

test("an unknown eBay condition never becomes 'new'", async () => {
  // Defaulting unknown to "new" would drop used goods into the new-item median.
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        itemSummaries: [
          {
            itemId: "1",
            itemWebUrl: "https://ebay.invalid/1",
            price: { value: "10.00", currency: "EUR" },
            condition: "Seller refurbished",
          },
          {
            itemId: "2",
            itemWebUrl: "https://ebay.invalid/2",
            price: { value: "10.00", currency: "EUR" },
            condition: "Wibble",
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const r = await new EbaySource({ EBAY_CLIENT_ID: "i", EBAY_CLIENT_SECRET: "s" }, fetchImpl).search("x");
  assert.equal(r.listings[0].condition, "refurbished");
  assert.equal(r.listings[1].condition, "unknown");
});

// ---------------------------------------------------------------------------
// The fixed marketplace set, and the two we may not query
// ---------------------------------------------------------------------------

test("all four prioritised marketplaces are covered", () => {
  const ids = MARKETPLACES.map((m) => m.id);
  for (const want of ["ebay", "amazon", "idealo", "kleinanzeigen"]) {
    assert.ok(ids.includes(want as never), `${want} missing from the registry`);
  }
});

test("idealo and Kleinanzeigen are link-outs, never sources", () => {
  // If either were ever wired up as a MarketplaceSource it would mean we had
  // started extracting data we are not permitted to extract.
  for (const id of ["idealo", "kleinanzeigen"] as const) {
    assert.equal(MARKETPLACES.find((m) => m.id === id)?.access, "link_out");
  }
});

test("link-out URLs are built correctly and escaped", () => {
  const targets = linkOutTargets("thinkpad x1 carbon");
  const idealo = targets.find((t) => t.id === "idealo")!;
  const kl = targets.find((t) => t.id === "kleinanzeigen")!;

  assert.match(idealo.url, /^https:\/\/www\.idealo\.de\//);
  assert.ok(idealo.url.includes("thinkpad%20x1%20carbon"));
  // Path-style search: /s-<slug>/k0
  assert.equal(kl.url, "https://www.kleinanzeigen.de/s-thinkpad-x1-carbon/k0");
});

test("a query that slugs to nothing still yields a usable URL", () => {
  const kl = linkOutTargets("!!! ???").find((t) => t.id === "kleinanzeigen")!;
  assert.equal(kl.url, "https://www.kleinanzeigen.de/s-suche/k0");
});

test("link-out targets never contribute listings or prices", async () => {
  // They are a separate field precisely so nothing from them can reach the
  // median. Claiming a cross-marketplace comparison that silently included a
  // site we never queried would be the worst kind of wrong.
  const r = await searchAll("thinkpad x1", [new StubSource()]);
  assert.equal(r.linkOut.length, 2);
  assert.ok(r.listings.every((l) => l.source !== "idealo" && l.source !== "kleinanzeigen"));
  assert.ok(!r.analysis.coverage.includes("idealo" as never));
});

// ---------------------------------------------------------------------------
// Amazon PA-API
// ---------------------------------------------------------------------------

test("Amazon reports not_configured and names what is missing", async () => {
  const r = await new AmazonSource({}).search("thinkpad");
  assert.equal(r.status, "not_configured");
  assert.match(r.detail ?? "", /AMAZON_ACCESS_KEY/);
  // The reason matters: an operator who does not know about the sales
  // requirement will assume they typed a key wrong.
  assert.match(r.detail ?? "", /qualifying sales/i);
});

test("the SigV4 signature is stable for a fixed clock and key", () => {
  // A signing bug surfaces only as an opaque 401 from a service we may not be
  // able to call at all, so it is pinned here instead.
  const a = signPaapiRequest({
    accessKey: "AKIAEXAMPLE",
    secretKey: "secret",
    host: "webservices.amazon.de",
    region: "eu-west-1",
    body: '{"Keywords":"thinkpad"}',
    now: new Date("2026-09-22T10:15:30Z"),
  });
  const b = signPaapiRequest({
    accessKey: "AKIAEXAMPLE",
    secretKey: "secret",
    host: "webservices.amazon.de",
    region: "eu-west-1",
    body: '{"Keywords":"thinkpad"}',
    now: new Date("2026-09-22T10:15:30Z"),
  });
  assert.equal(a.headers.authorization, b.headers.authorization);

  // Every signed header must actually be sent, byte for byte, or the service
  // rejects the request.
  const signedList = /SignedHeaders=([^,]+)/.exec(a.headers.authorization)![1].split(";");
  for (const h of signedList) {
    assert.ok(h in a.headers, `signed header "${h}" is not being sent`);
  }
  assert.deepEqual(signedList, [...signedList].sort(), "signed headers must be sorted");
  assert.equal(a.headers["x-amz-date"], "20260922T101530Z");
  assert.match(a.headers.authorization, /Credential=AKIAEXAMPLE\/20260922\/eu-west-1\/ProductAdvertisingAPI\/aws4_request/);
});

test("a different body produces a different signature", () => {
  const base = {
    accessKey: "AKIAEXAMPLE",
    secretKey: "secret",
    host: "webservices.amazon.de",
    region: "eu-west-1",
    now: new Date("2026-09-22T10:15:30Z"),
  };
  const a = signPaapiRequest({ ...base, body: '{"Keywords":"a"}' });
  const b = signPaapiRequest({ ...base, body: '{"Keywords":"b"}' });
  assert.notEqual(a.headers.authorization, b.headers.authorization);
});

test("an ineligible Associates account is explained, not just 401'd", async () => {
  const fetchImpl = (async () =>
    new Response('{"Errors":[{"Code":"AssociateNotEligible"}]}', { status: 401 })) as unknown as typeof fetch;

  const r = await new AmazonSource(
    { AMAZON_ACCESS_KEY: "k", AMAZON_SECRET_KEY: "s", AMAZON_PARTNER_TAG: "t" },
    fetchImpl,
  ).search("x");

  assert.equal(r.status, "error");
  assert.match(r.detail ?? "", /qualifying sales/i);
});

test("Amazon prices convert to integer minor units", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        SearchResult: {
          Items: [
            {
              ASIN: "B01",
              DetailPageURL: "https://amazon.de/dp/B01",
              ItemInfo: { Title: { DisplayValue: "Thing" } },
              Offers: { Listings: [{ Price: { Amount: 19.99, Currency: "EUR" }, Condition: { Value: "New" } }] },
            },
            // No price: dropped rather than guessed at.
            { ASIN: "B02", DetailPageURL: "https://amazon.de/dp/B02" },
          ],
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const r = await new AmazonSource(
    { AMAZON_ACCESS_KEY: "k", AMAZON_SECRET_KEY: "s", AMAZON_PARTNER_TAG: "t" },
    fetchImpl,
  ).search("thing");

  assert.equal(r.status, "ok");
  assert.equal(r.listings.length, 1);
  assert.equal(r.listings[0].price.amount, 1999);
  assert.ok(Number.isInteger(r.listings[0].price.amount));
});

test("an unknown AMAZON_LOCALE fails loudly rather than guessing a host", async () => {
  const r = await new AmazonSource({
    AMAZON_ACCESS_KEY: "k",
    AMAZON_SECRET_KEY: "s",
    AMAZON_PARTNER_TAG: "t",
    AMAZON_LOCALE: "ZZ",
  }).search("x");
  assert.equal(r.status, "error");
  assert.match(r.detail ?? "", /AMAZON_LOCALE/);
});

// ---------------------------------------------------------------------------
// eBay environments
// ---------------------------------------------------------------------------

test("sandbox and production hit different hosts", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(String(url));
    if (String(url).includes("oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ itemSummaries: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await new EbaySource(
    { EBAY_CLIENT_ID: "i", EBAY_CLIENT_SECRET: "s", EBAY_ENV: "sandbox" },
    fetchImpl,
  ).search("x");
  assert.ok(seen.every((u) => u.includes("api.sandbox.ebay.com")), seen.join(" "));

  seen.length = 0;
  await new EbaySource(
    { EBAY_CLIENT_ID: "i", EBAY_CLIENT_SECRET: "s" },
    fetchImpl,
  ).search("x");
  assert.ok(seen.every((u) => u.includes("api.ebay.com") && !u.includes("sandbox")), seen.join(" "));
});

test("an unrecognised EBAY_ENV falls back to production, never sandbox", async () => {
  // Silently serving eBay's test inventory as the real market would be worse
  // than not running at all, so sandbox must always be an explicit choice.
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
  }) as unknown as typeof fetch;

  await new EbaySource(
    { EBAY_CLIENT_ID: "i", EBAY_CLIENT_SECRET: "s", EBAY_ENV: "staging" },
    fetchImpl,
  ).search("x");
  assert.ok(!seen[0].includes("sandbox"));
});

test("sandbox results are labelled as test data", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ itemSummaries: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const r = await new EbaySource(
    { EBAY_CLIENT_ID: "i", EBAY_CLIENT_SECRET: "s", EBAY_ENV: "sandbox" },
    fetchImpl,
  ).search("x");
  assert.equal(r.status, "ok");
  assert.match(r.detail ?? "", /SANDBOX/);
  assert.match(r.detail ?? "", /not real listings/i);
});

test("a disabled production keyset is explained, not just 'invalid_client'", async () => {
  // The failure everyone hits first: production keysets are created disabled.
  // The raw error does not say so.
  const fetchImpl = (async () =>
    new Response('{"error":"invalid_client"}', { status: 401 })) as unknown as typeof fetch;

  const r = await new EbaySource({ EBAY_CLIENT_ID: "i", EBAY_CLIENT_SECRET: "s" }, fetchImpl).search("x");
  assert.equal(r.status, "error");
  assert.match(r.detail ?? "", /account deletion notification/i);
});

test("the OAuth scope stays on api.ebay.com even in sandbox", async () => {
  // It is an identifier, not an address. Rewriting it to the sandbox host is a
  // common way to get an unhelpful invalid_scope error.
  let body = "";
  const fetchImpl = (async (url: string, init: RequestInit) => {
    // Capture the TOKEN request only — the search call that follows has no
    // body and would otherwise overwrite what we are asserting on.
    if (String(url).includes("oauth2/token")) body = String(init.body ?? "");
    return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
  }) as unknown as typeof fetch;

  await new EbaySource(
    { EBAY_CLIENT_ID: "i", EBAY_CLIENT_SECRET: "s", EBAY_ENV: "sandbox" },
    fetchImpl,
  ).search("x");
  assert.ok(body.includes(encodeURIComponent("https://api.ebay.com/oauth/api_scope")));
});

// ---------------------------------------------------------------------------
// Affiliate product feeds — the legitimate route to retailers without an API
// ---------------------------------------------------------------------------

test("quoted commas in a title do not shift the columns", async () => {
  // THE BUG THIS PARSER EXISTS TO AVOID. Product titles contain commas
  // constantly, and a split(",") shifts every later column by one — so the
  // price column silently reads a spec string, or another field's number.
  // A corrupted price here corrupts the median for every other source.
  const rows = parseDelimited(
    'product_name,search_price,aw_deep_link\n"Lenovo ThinkPad X1, 14 Zoll, 16GB",1299.00,https://x.invalid/1\n',
  );
  assert.equal(rows[1][0], "Lenovo ThinkPad X1, 14 Zoll, 16GB");
  assert.equal(rows[1][1], "1299.00");
  assert.equal(rows[1][2], "https://x.invalid/1");
});

test("escaped quotes and embedded newlines survive parsing", () => {
  const rows = parseDelimited('a,b\n"say ""hi""","line1\nline2"\n');
  assert.equal(rows[1][0], 'say "hi"');
  assert.equal(rows[1][1], "line1\nline2");
});

test("prices parse in both German and English notation", () => {
  assert.equal(feedPriceToMinorUnits("19.99"), 1999);
  assert.equal(feedPriceToMinorUnits("19,99"), 1999);
  assert.equal(feedPriceToMinorUnits("1.234,56"), 123456);
  assert.equal(feedPriceToMinorUnits("1,234.56"), 123456);
  assert.equal(feedPriceToMinorUnits("1299"), 129900);
  assert.equal(feedPriceToMinorUnits("19.99 EUR"), 1999);
  assert.equal(feedPriceToMinorUnits(""), null);
  assert.equal(feedPriceToMinorUnits("n/a"), null);
});

function feedResponse(csv: string) {
  return (async () => new Response(csv, { status: 200 })) as unknown as typeof fetch;
}

const FEED_CSV =
  "aw_product_id,product_name,search_price,currency,aw_deep_link,merchant_name,condition\n" +
  '1,"Lenovo ThinkPad X1 Carbon, 14 Zoll",1299.00,EUR,https://shop.invalid/1,TechMerchant,new\n' +
  "2,Dell XPS 13,1099.00,EUR,https://shop.invalid/2,TechMerchant,new\n" +
  "3,ThinkPad X1 Yoga,1199.00,EUR,https://shop.invalid/3,OtherShop,refurbished\n";

const FEED_ENV = { FEED_URL: "https://feed.invalid/products.csv", FEED_LABEL: "Awin merchants" };

test("a feed source is searchable and maps to listings", async () => {
  const r = await new FeedSource(FEED_ENV, feedResponse(FEED_CSV)).search("thinkpad x1");
  assert.equal(r.status, "ok");
  assert.equal(r.listings.length, 2, "both ThinkPad X1 rows should match");
  assert.equal(r.listings[0].price.amount, 129900);
  assert.equal(r.listings[0].seller.handle, "TechMerchant");
  assert.equal(r.listings[0].source, "feed");
});

test("all query terms must match, not any", async () => {
  // An OR match floods the results with anything sharing one common word, and
  // those prices then drag the median.
  const r = await new FeedSource(FEED_ENV, feedResponse(FEED_CSV)).search("thinkpad yoga");
  assert.equal(r.listings.length, 1);
  assert.match(r.listings[0].title, /Yoga/);
});

test("a feed says it is a snapshot, not a live price", async () => {
  const r = await new FeedSource(FEED_ENV, feedResponse(FEED_CSV)).search("thinkpad");
  assert.match(r.detail ?? "", /snapshot/i);
  assert.match(r.detail ?? "", /Awin merchants/);
});

test("a feed missing required columns fails loudly", async () => {
  // Returning an empty result would read as "no matches", which is a different
  // and misleading claim.
  const r = await new FeedSource(
    FEED_ENV,
    feedResponse("id,name,cost\n1,Thing,10\n"),
  ).search("thing");
  assert.equal(r.status, "error");
  assert.match(r.detail ?? "", /missing required column/i);
  // "name" IS a recognised title column, so only url and price are missing —
  // and the message must name exactly those, not a generic complaint.
  assert.match(r.detail ?? "", /url/);
  assert.match(r.detail ?? "", /price/);
  // And it echoes the header it actually saw, so the fix is obvious.
  assert.match(r.detail ?? "", /id, name, cost/);
});

test("rows without a usable price are dropped, not guessed", async () => {
  const csv =
    "product_name,search_price,aw_deep_link\n" +
    "Good Thing,10.00,https://x.invalid/1\n" +
    "Bad Thing,ask us,https://x.invalid/2\n";
  const r = await new FeedSource(FEED_ENV, feedResponse(csv)).search("thing");
  assert.equal(r.listings.length, 1);
  assert.equal(r.listings[0].title, "Good Thing");
});

test("an unconfigured feed is not an error", async () => {
  const r = await new FeedSource({}).search("thing");
  assert.equal(r.status, "not_configured");
  assert.match(r.detail ?? "", /FEED_URL/);
});

test("the feed is loaded once and reused", async () => {
  // A network feed can be hundreds of megabytes. Re-fetching per search would
  // make the page unusable and hammer the network provider.
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches++;
    return new Response(FEED_CSV, { status: 200 });
  }) as unknown as typeof fetch;

  const src = new FeedSource(FEED_ENV, fetchImpl);
  await src.search("thinkpad");
  await src.search("dell");
  await src.search("yoga");
  assert.equal(fetches, 1);
});

test("a feed fetch failure is an error, never silent emptiness", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const r = await new FeedSource(FEED_ENV, fetchImpl).search("thing");
  assert.equal(r.status, "error");
  assert.match(r.detail ?? "", /503/);
});

// ---------------------------------------------------------------------------
// Non-comparable sources: shown, checked, never pooled into the median
// ---------------------------------------------------------------------------

function etsyLike(listings: Listing[]): SourceResult {
  return { source: "etsy", status: "ok", listings, comparable: false };
}

test("a non-comparable source's cheap listings are never flagged as underpriced", () => {
  // THE REASON THIS MECHANISM EXISTS. Search Etsy for a laptop and you get
  // sleeves and stickers at a tenth of the price. Pooled, each would be flagged
  // "well below the median" — a false scam flag on an honest maker.
  const a = analyse([
    ok(honest(10)),
    etsyLike([listing({ id: "sleeve", source: "etsy", price: { amount: 1500, currency: "EUR" } })]),
  ]);
  assert.equal(a.status, "ok");
  assert.ok(!a.flags.some((f) => f.listingId === "sleeve" && f.kind === "underpriced"));
});

test("non-comparable listings do not move the median", () => {
  // The other half of the damage: cheap handmade goods would sink the median
  // and blunt the check for every retail listing.
  const alone = analyse([ok(honest(10))]);
  const withEtsy = analyse([
    ok(honest(10)),
    etsyLike(
      Array.from({ length: 30 }, (_, i) =>
        listing({ id: `e${i}`, source: "etsy", price: { amount: 900, currency: "EUR" } }),
      ),
    ),
  ]);
  assert.equal(withEtsy.median, alone.median);
  assert.equal(withEtsy.sampleSize, alone.sampleSize);
});

test("coverage does not claim a non-comparable source", () => {
  // "Median across 3 marketplaces" must not count one whose prices were set aside.
  const a = analyse([ok(honest(10)), etsyLike([listing({ id: "x", source: "etsy" })])]);
  assert.deepEqual(a.coverage, ["stub"]);
  assert.deepEqual(a.excludedFromComparison, ["etsy"]);
});

test("a failed non-comparable source does not block the price comparison", () => {
  // It was never going to contribute to the median, so its absence biases
  // nothing. Blocking here would throw away a valid comparison for no reason.
  const a = analyse([
    ok([...honest(10), listing({ id: "bait", price: { amount: 2000, currency: "EUR" } })]),
    { source: "etsy", status: "timeout", listings: [], comparable: false },
  ]);
  assert.equal(a.status, "ok");
  assert.deepEqual(a.degraded, []);
  assert.ok(a.flags.some((f) => f.listingId === "bait" && f.kind === "underpriced"));
});

test("a failed COMPARABLE source still blocks it", () => {
  // The exemption must be exactly that narrow.
  const a = analyse([ok(honest(20)), { source: "ebay", status: "timeout", listings: [], comparable: true }]);
  assert.equal(a.status, "incomplete_coverage");
});

test("non-comparable listings still get the price-independent checks", () => {
  // A two-day-old shop is two days old on any marketplace.
  const a = analyse([
    ok(honest(10)),
    etsyLike([
      listing({
        id: "fresh",
        source: "etsy",
        seller: { handle: "shop:1", memberSince: Math.floor(Date.now() / 1000) - 2 * 86400 },
      }),
    ]),
  ]);
  assert.ok(a.flags.some((f) => f.listingId === "fresh" && f.kind === "new_account"));
});

test("searchAll attaches comparability from the source, even when it throws", async () => {
  // A thrown error carries nothing, so the orchestrator must supply it — or a
  // crashed non-comparable source would be treated as comparable and block
  // the comparison.
  const exploding: MarketplaceSource = {
    id: "etsy",
    priceComparable: false,
    search: async () => {
      throw new Error("kaboom");
    },
  };
  const r = await searchAll("thinkpad x1", [new StubSource(), exploding]);
  assert.equal(r.analysis.status, "ok", r.analysis.reason);
  assert.deepEqual(r.analysis.degraded, []);
});

// ---------------------------------------------------------------------------
// Etsy source
// ---------------------------------------------------------------------------

const ETSY_ENV = { ETSY_KEYSTRING: "key123", ETSY_SHARED_SECRET: "sec456" };

function etsyFetch(opts: {
  search?: unknown;
  batch?: unknown;
  batchStatus?: number;
  seen?: { url: string; key?: string }[];
}) {
  return (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    opts.seen?.push({ url: String(url), key: headers?.["x-api-key"] });
    if (String(url).includes("/listings/batch")) {
      return new Response(JSON.stringify(opts.batch ?? { results: [] }), { status: opts.batchStatus ?? 200 });
    }
    return new Response(JSON.stringify(opts.search ?? { results: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

const ETSY_SEARCH = {
  count: 2,
  results: [
    {
      listing_id: 101,
      title: "Hand-stitched ThinkPad X1 sleeve",
      url: "https://www.etsy.com/listing/101",
      price: { amount: 2499, divisor: 100, currency_code: "eur" },
      shop_id: 555,
      when_made: "made_to_order",
      creation_timestamp: 1790000000,
      original_creation_timestamp: 1780000000,
    },
    {
      listing_id: 102,
      title: "Vintage keyboard",
      url: "https://www.etsy.com/listing/102",
      price: { amount: 8000, divisor: 100, currency_code: "EUR" },
      shop_id: 556,
      when_made: "1990s",
    },
  ],
};

const ETSY_BATCH = {
  results: [
    {
      listing_id: 101,
      shop: { shop_name: "StitchWorks", create_date: 1700000000, review_count: 312 },
      images: [{ url_570xN: "https://i.etsystatic.com/101.jpg" }],
    },
  ],
};

test("Etsy is not_configured without BOTH key parts", async () => {
  const r = await new EtsySource({ ETSY_KEYSTRING: "k" }).search("x");
  assert.equal(r.status, "not_configured");
  assert.match(r.detail ?? "", /ETSY_SHARED_SECRET/);
});

test("Etsy sends x-api-key as keystring:shared_secret on every call", async () => {
  // The keystring alone — what older guides show — is rejected by v3.
  const seen: { url: string; key?: string }[] = [];
  await new EtsySource(ETSY_ENV, etsyFetch({ search: ETSY_SEARCH, batch: ETSY_BATCH, seen })).search("thinkpad");
  assert.equal(seen.length, 2, "one search call, one batch enrichment call");
  for (const s of seen) assert.equal(s.key, "key123:sec456");
  assert.match(seen[0].url, /\/v3\/application\/listings\/active\?keywords=thinkpad/);
  assert.match(seen[1].url, /\/v3\/application\/listings\/batch\?listing_ids=101,102&includes=Shop,Images/);
});

test("Etsy declares its prices non-comparable", () => {
  assert.equal(new EtsySource().priceComparable, false);
});

test("Etsy listings map with the spec's field names", async () => {
  const r = await new EtsySource(ETSY_ENV, etsyFetch({ search: ETSY_SEARCH, batch: ETSY_BATCH })).search("thinkpad");
  assert.equal(r.status, "ok");
  const l = r.listings.find((x) => x.id === "101")!;
  assert.equal(l.price.amount, 2499);
  assert.equal(l.price.currency, "EUR", "currency is upper-cased");
  assert.equal(l.condition, "new");
  assert.equal(l.seller.displayName, "StitchWorks");
  assert.equal(l.seller.memberSince, 1700000000);
  assert.equal(l.seller.feedbackScore, 312);
  assert.equal(l.imageUrl, "https://i.etsystatic.com/101.jpg");
  assert.equal(l.listedAt, 1780000000, "original creation time, not the renewal time");
  assert.equal(l.shipping, undefined, "shipping is unknown, not zero");
});

test("the Etsy seller handle is the immutable shop id, not the renameable name", async () => {
  // An attestation keyed to a shop NAME is orphaned the day the seller renames
  // their shop. The numeric id never changes.
  const r = await new EtsySource(ETSY_ENV, etsyFetch({ search: ETSY_SEARCH, batch: ETSY_BATCH })).search("x");
  assert.equal(r.listings.find((x) => x.id === "101")!.seller.handle, "shop:555");
});

test("Etsy's star average is not passed off as a positive-feedback percentage", async () => {
  const batch = { results: [{ listing_id: 101, shop: { shop_name: "S", review_count: 10, review_average: 4.9 } }] };
  const r = await new EtsySource(ETSY_ENV, etsyFetch({ search: ETSY_SEARCH, batch })).search("x");
  assert.equal(r.listings.find((x) => x.id === "101")!.seller.feedbackPercentage, undefined);
});

test("a failed enrichment still returns the listings, and says what is missing", async () => {
  // Losing a thumbnail must never cost the buyer the listing.
  const r = await new EtsySource(ETSY_ENV, etsyFetch({ search: ETSY_SEARCH, batchStatus: 500 })).search("x");
  assert.equal(r.status, "ok");
  assert.equal(r.listings.length, 2);
  assert.equal(r.listings[0].seller.displayName, undefined);
  assert.match(r.detail ?? "", /Shop details could not be loaded/);
});

test("Etsy money converts via amount/divisor, in integer minor units", () => {
  assert.equal(etsyMoneyToMinorUnits({ amount: 2499, divisor: 100, currency_code: "EUR" }), 2499);
  assert.equal(etsyMoneyToMinorUnits({ amount: 24990, divisor: 1000, currency_code: "EUR" }), 2499);
  assert.equal(etsyMoneyToMinorUnits({ amount: 5, divisor: 1, currency_code: "EUR" }), 500);
  // Anything that cannot be a real price drops the listing.
  assert.equal(etsyMoneyToMinorUnits({ amount: 100, divisor: 0, currency_code: "EUR" }), null);
  assert.equal(etsyMoneyToMinorUnits({ amount: 0, divisor: 100, currency_code: "EUR" }), null);
  assert.equal(etsyMoneyToMinorUnits(undefined), null);
});

test("when_made maps to condition without overclaiming 'new'", () => {
  assert.equal(etsyCondition("made_to_order"), "new");
  assert.equal(etsyCondition("2020_2026"), "new");
  assert.equal(etsyCondition("2010_2019"), "unknown");
  assert.equal(etsyCondition("1990s"), "used");
  assert.equal(etsyCondition("before_1700"), "used");
  assert.equal(etsyCondition(undefined), "unknown");
});

test("an Etsy 401 explains the two-part key", async () => {
  const fetchImpl = (async () => new Response("Invalid API key", { status: 401 })) as unknown as typeof fetch;
  const r = await new EtsySource(ETSY_ENV, fetchImpl).search("x");
  assert.equal(r.status, "error");
  assert.match(r.detail ?? "", /keystring:shared_secret/);
});

test("an Etsy 429 is rate_limited", async () => {
  const fetchImpl = (async () => new Response("slow", { status: 429 })) as unknown as typeof fetch;
  const r = await new EtsySource(ETSY_ENV, fetchImpl).search("x");
  assert.equal(r.status, "rate_limited");
});

test("the search page and the API route share one source list", () => {
  // Two copies of a list are two lists. Pinned so they cannot drift again.
  assert.deepEqual(
    defaultSources({}).map((s) => s.id),
    ["ebay", "amazon", "etsy", "feed", "stub"],
  );
  assert.deepEqual(
    defaultSources({ STUB_FEED: "false" }).map((s) => s.id),
    ["ebay", "amazon", "etsy", "feed"],
  );
});
