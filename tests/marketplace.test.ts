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
