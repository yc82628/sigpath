import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createPublicKey, verify } from "crypto";
import { generateVapidKeys, vapidFromEnv, vapidJwt, sendTickle, isPushEndpoint } from "../lib/alerts/push";
import { WatchStore, normaliseQuery, MAX_WATCHES_PER_BROWSER, WATCH_TTL_SECS } from "../lib/alerts/watches";
import { createWatch, listWatches, deleteWatch, collectInbox } from "../lib/alerts/api";
import { checkWatches } from "../lib/alerts/check";
import { analyse } from "../lib/marketplace/anomaly";
import type { Listing, SourceResult } from "../lib/marketplace/types";
import { toMinorUnits } from "../app/components/push";

const keys = generateVapidKeys();
const ENV = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };
const EP = "https://fcm.googleapis.com/fcm/send/abc123";
const EP2 = "https://updates.push.services.mozilla.com/wpush/v2/xyz";
const NOW = Date.UTC(2026, 9, 2, 12);
const NOW_S = Math.floor(NOW / 1000);

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const store = () => new WatchStore(join(mkdtempSync(join(tmpdir(), "sigpath-alerts-")), "watches.json"));

// --- VAPID ----------------------------------------------------------------------------

test("the VAPID JWT is ES256, signed by our key, for the push service's origin, under 24h", () => {
  const v = vapidFromEnv(ENV)!;
  const jwt = vapidJwt("https://fcm.googleapis.com", v, NOW_S);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(b64url(h).toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(b64url(c).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.ok(claims.exp - NOW_S <= 24 * 3600 && claims.exp > NOW_S);
  const point = b64url(keys.publicKey);
  const pub = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
    format: "jwk",
  });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, b64url(s)));
});

test("missing or malformed VAPID keys mean alerts are off, not broken", () => {
  assert.equal(vapidFromEnv({}), null);
  assert.equal(vapidFromEnv({ ...ENV, VAPID_PUBLIC_KEY: "short" }), null);
});

test("only real push services are ever sent to — an endpoint is attacker-supplied", () => {
  assert.ok(isPushEndpoint(EP));
  assert.ok(isPushEndpoint(EP2));
  assert.ok(!isPushEndpoint("http://fcm.googleapis.com/fcm/send/x"), "https only");
  assert.ok(!isPushEndpoint("https://fcm.googleapis.com.evil.example/x"), "no lookalikes");
  assert.ok(!isPushEndpoint("https://169.254.169.254/latest/meta-data"), "not a request relay");
  assert.ok(!isPushEndpoint("not a url"));
});

test("a tickle is an empty POST with the VAPID header; 410 means unsubscribed", async () => {
  const v = vapidFromEnv(ENV)!;
  let seen: { url: string; init: RequestInit } | null = null;
  const sent = await sendTickle(EP, v, (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch);
  assert.equal(sent, "sent");
  const headers = seen!.init.headers as Record<string, string>;
  assert.match(headers.authorization, new RegExp(`^vapid t=[^.]+\\.[^.]+\\.[^,]+, k=${keys.publicKey}$`));
  assert.equal(seen!.init.body, undefined, "nothing about the deal passes through the push service");
  assert.equal(await sendTickle(EP, v, (async () => new Response(null, { status: 410 })) as unknown as typeof fetch), "gone");
  let called = false;
  const r = await sendTickle("https://evil.example/x", v, (async () => ((called = true), new Response())) as unknown as typeof fetch);
  assert.ok(typeof r === "object" && !called);
});

// --- creating, listing, deleting -------------------------------------------------------

const valid = { subscription: { endpoint: EP }, query: "ThinkPad  X1", group: "new", target: { amount: 35000, currency: "eur" } };

test("an alert stores the search, condition and target — and is never shown back with its endpoint", async () => {
  const s = store();
  const r = await createWatch(valid, { store: s, env: ENV, now: NOW });
  assert.ok(r.ok);
  assert.equal(r.watch.query, "ThinkPad X1");
  assert.deepEqual(r.watch.target, { amount: 35000, currency: "EUR" });
  assert.equal(r.watch.expiresAt, NOW_S + WATCH_TTL_SECS);
  assert.ok(!JSON.stringify(r.watch).includes(EP));
  const l = await listWatches({ endpoint: EP }, s);
  assert.ok(l.ok && l.watches.length === 1 && !JSON.stringify(l.watches).includes(EP));
});

test("bad input is refused, and nothing works without VAPID keys", async () => {
  const s = store();
  assert.equal((await createWatch(valid, { store: s, env: {} })).ok, false);
  for (const bad of [
    { ...valid, subscription: { endpoint: "https://evil.example/x" } },
    { ...valid, query: "" },
    { ...valid, query: "x".repeat(121) },
    { ...valid, group: "refurb" },
    { ...valid, target: { amount: 0, currency: "EUR" } },
    { ...valid, target: { amount: 12.5, currency: "EUR" } },
    { ...valid, target: { amount: 100, currency: "euro" } },
  ]) {
    const r = await createWatch(bad as Record<string, unknown>, { store: s, env: ENV });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test(`a browser can keep ${MAX_WATCHES_PER_BROWSER} alerts, not more`, async () => {
  const s = store();
  for (let i = 0; i < MAX_WATCHES_PER_BROWSER; i++) assert.ok((await createWatch({ ...valid, query: `q${i}` }, { store: s, env: ENV })).ok);
  const over = await createWatch(valid, { store: s, env: ENV });
  assert.equal(!over.ok && over.status, 409);
  assert.ok((await createWatch({ ...valid, subscription: { endpoint: EP2 } }, { store: s, env: ENV })).ok, "another browser is unaffected");
});

test("only the browser that set an alert can delete it", async () => {
  const s = store();
  const r = await createWatch(valid, { store: s, env: ENV });
  assert.ok(r.ok);
  assert.equal((await deleteWatch({ endpoint: EP2, id: r.watch.id }, s)).ok, false);
  assert.ok((await deleteWatch({ endpoint: EP, id: r.watch.id }, s)).ok);
  assert.equal((await s.forEndpoint(EP)).length, 0);
});

// --- the checker --------------------------------------------------------------------------

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "l1",
    source: "stub",
    title: "ThinkPad",
    url: "https://example.invalid/1",
    price: { amount: 40000, currency: "EUR" },
    shipping: { amount: 0, currency: "EUR" },
    condition: "new",
    seller: { handle: "s" },
    ...over,
  };
}
const market = (extra: Listing[] = [], status: SourceResult["status"] = "ok") => {
  const honest = Array.from({ length: 8 }, (_, i) => listing({ id: `ok-${i}`, seller: { handle: `s${i}` } }));
  const results: SourceResult[] = [{ source: "stub", status, listings: status === "ok" ? [...honest, ...extra] : [] }];
  if (status !== "ok") results.push({ source: "ebay", status: "ok", listings: [...honest, ...extra].map((l) => ({ ...l, source: "ebay" as const })) });
  return { listings: results.flatMap((r) => r.listings), analysis: analyse(results) };
};

async function setUp(target = 35000) {
  const s = store();
  const r = await createWatch({ ...valid, target: { amount: target, currency: "EUR" } }, { store: s, env: ENV, now: NOW });
  assert.ok(r.ok);
  const tickles: string[] = [];
  const notify = async (e: string) => (tickles.push(e), "sent" as const);
  return { s, tickles, notify, id: r.watch.id };
}

test("a checked deal at or under the target alerts, once, and the inbox hands it over once", async () => {
  const { s, tickles, notify } = await setUp();
  const searched: string[] = [];
  const search = async (q: string) => (searched.push(q), market([listing({ id: "deal", price: { amount: 34000, currency: "EUR" } })]));
  const r = await checkWatches({ store: s, search, notify, now: NOW });
  assert.equal(r.alerted, 1);
  assert.deepEqual(searched, ["thinkpad x1"]);
  assert.deepEqual(tickles, [EP]);
  const inbox = await collectInbox({ endpoint: EP }, s);
  assert.ok(inbox.ok && inbox.alerts.length === 1);
  assert.match(inbox.alerts[0].title, /340\.00/);
  assert.match(inbox.alerts[0].body, /SigPath-checked new deal/);
  assert.match(inbox.alerts[0].url, /^\/search\?q=ThinkPad%20X1&checked=1#l-stub:deal$/);
  const again = await collectInbox({ endpoint: EP }, s);
  assert.ok(again.ok && again.alerts.length === 0);
});

test("a bait listing far under the target NEVER alerts — only checked deals fire", async () => {
  const { s, tickles, notify } = await setUp();
  const search = async () => market([listing({ id: "bait", price: { amount: 5000, currency: "EUR" } })]);
  const r = await checkWatches({ store: s, search, notify, now: NOW });
  assert.equal(r.alerted, 0);
  assert.equal(tickles.length, 0);
});

test("the same price twice is one alert; a new low is another", async () => {
  const { s, tickles, notify } = await setUp();
  const at = (amount: number) => async () => market([listing({ id: "deal", price: { amount, currency: "EUR" } })]);
  await checkWatches({ store: s, search: at(34000), notify, now: NOW });
  await checkWatches({ store: s, search: at(34000), notify, now: NOW + 3600_000 });
  assert.equal(tickles.length, 1);
  await checkWatches({ store: s, search: at(33500), notify, now: NOW + 7200_000 });
  assert.equal(tickles.length, 2);
});

test("a search with a marketplace down can't alert — nothing is checked without full coverage", async () => {
  const { s, tickles, notify } = await setUp();
  const search = async () => market([listing({ id: "deal", price: { amount: 34000, currency: "EUR" } })], "timeout");
  await checkWatches({ store: s, search, notify, now: NOW });
  assert.equal(tickles.length, 0);
});

test("an unsubscribed browser's alerts are deleted; expired alerts are swept", async () => {
  const { s, notify } = await setUp();
  const search = async () => market([listing({ id: "deal", price: { amount: 34000, currency: "EUR" } })]);
  const gone = await checkWatches({ store: s, search, notify: async () => "gone" as const, now: NOW });
  assert.equal(gone.gone, 1);
  assert.equal((await s.forEndpoint(EP)).length, 0);

  const t = await setUp();
  const later = await checkWatches({ store: t.s, search, notify, now: NOW + (WATCH_TTL_SECS + 1) * 1000 });
  assert.equal(later.expired, 1);
  assert.equal(later.searches, 0);
});

test("watchers of the same search share one query per pass, and each browser gets one push", async () => {
  const s = store();
  for (const [endpoint, query] of [[EP, "ThinkPad X1"], [EP, "thinkpad  x1"], [EP2, "THINKPAD X1"]]) {
    assert.ok((await createWatch({ ...valid, subscription: { endpoint }, query }, { store: s, env: ENV, now: NOW })).ok);
  }
  let searches = 0;
  const tickles: string[] = [];
  await checkWatches({
    store: s,
    search: async () => (searches++, market([listing({ id: "deal", price: { amount: 34000, currency: "EUR" } })])),
    notify: async (e) => (tickles.push(e), "sent" as const),
    now: NOW,
  });
  assert.equal(searches, 1);
  assert.deepEqual(tickles.sort(), [EP, EP2].sort());
});

// --- small things ------------------------------------------------------------------

test("queries normalise for sharing; prices parse from what people type", () => {
  assert.equal(normaliseQuery("  ThinkPad   X1 "), "thinkpad x1");
  assert.equal(toMinorUnits("356"), 35600);
  assert.equal(toMinorUnits("356,5"), 35650);
  assert.equal(toMinorUnits("356.99"), 35699);
  assert.equal(toMinorUnits("0"), null);
  assert.equal(toMinorUnits("3.999"), null);
  assert.equal(toMinorUnits("cheap"), null);
});
