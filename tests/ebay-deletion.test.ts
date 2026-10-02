import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync, randomBytes, sign } from "crypto";
import { Keypair } from "@solana/web3.js";
import {
  challengeResponse,
  deletionConfig,
  parseNotice,
  verifyEbaySignature,
  purgeEbayUser,
  deletedPseudonym,
} from "../lib/marketplace/ebay-deletion";
import { OrderMetaStore } from "../lib/reports/order-meta";
import { DecisionLog, ReportStore } from "../lib/reports/reports";
import { CaseLog } from "../lib/reports/cases";
import { VerifiedSellerLog } from "../lib/sellers/verified-log";
import { startSearch, assembleSearch, searchAll } from "../lib/marketplace/search";
import { StubSource } from "../lib/marketplace/sources/stub";
import type { MarketplaceSource } from "../lib/marketplace/sources/types";

// --- the challenge -------------------------------------------------------------------

test("the challenge answer is hex sha256(code + token + endpoint) — checked against sha256sum, not our own code", () => {
  // printf '%s' "abc123" "TOKEN_…" "https://…/api/ebay/account-deletion" | sha256sum
  assert.equal(
    challengeResponse("abc123", "TOKEN_0123456789abcdefghijklmnopqrstuv", "https://sigpath.example/api/ebay/account-deletion"),
    "44e7d84efd07e8b158a2167063e0d631e38fb596c04719d6b3de43ec01140903",
  );
});

test("the endpoint is off unless the token follows eBay's rules and the endpoint is https", () => {
  const token = "A".repeat(40);
  assert.ok(deletionConfig({ EBAY_VERIFICATION_TOKEN: token, EBAY_DELETION_ENDPOINT: "https://x.example/api/ebay/account-deletion" }));
  assert.equal(deletionConfig({ EBAY_VERIFICATION_TOKEN: "short", EBAY_DELETION_ENDPOINT: "https://x.example/a" }), null);
  assert.equal(deletionConfig({ EBAY_VERIFICATION_TOKEN: "bad token!".repeat(5), EBAY_DELETION_ENDPOINT: "https://x.example/a" }), null);
  assert.equal(deletionConfig({ EBAY_VERIFICATION_TOKEN: token, EBAY_DELETION_ENDPOINT: "http://x.example/a" }), null);
  assert.equal(deletionConfig({}), null);
});

// --- the notice and its signature ----------------------------------------------------------

const notice = (username = "Fake_Goods_24", topic = "MARKETPLACE_ACCOUNT_DELETION") =>
  JSON.stringify({
    metadata: { topic, schemaVersion: "1.0", deprecated: false },
    notification: {
      notificationId: "n-1",
      eventDate: "2026-10-02T10:00:00.000Z",
      publishDate: "2026-10-02T10:00:01.000Z",
      publishAttemptCount: 1,
      data: { username, userId: "u-1", eiasToken: "eias" },
    },
  });

test("only a deletion notice with a username is acted on", () => {
  assert.deepEqual(parseNotice(JSON.parse(notice())), { notificationId: "n-1", username: "Fake_Goods_24", userId: "u-1" });
  assert.equal(parseNotice(JSON.parse(notice("x", "SOME_OTHER_TOPIC"))), null);
  assert.equal(parseNotice(JSON.parse(notice("   "))), null);
  assert.equal(parseNotice(null), null);
});

const ebayKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = ebayKey.publicKey.export({ type: "spki", format: "pem" }).toString();
const header = (body: string, kid = "kid-1", key = ebayKey.privateKey) =>
  Buffer.from(JSON.stringify({ alg: "ECDSA", kid, signature: sign("sha1", Buffer.from(body), { key, dsaEncoding: "der" }).toString("base64"), digest: "SHA1" })).toString("base64");
const keys = async (kid: string) => (kid === "kid-1" ? pem : null);

test("a notice signed by eBay's key verifies; tampered, foreign or unsigned ones don't", async () => {
  const body = notice();
  assert.ok(await verifyEbaySignature(body, header(body), keys));
  assert.ok(await verifyEbaySignature(body, header(body), async () => pem.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s/g, "")), "un-armoured key form");
  assert.equal(await verifyEbaySignature(notice("Someone_Else"), header(body), keys), false, "body swapped under a valid signature");
  assert.equal(await verifyEbaySignature(body, header(body, "kid-1", generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), keys), false);
  assert.equal(await verifyEbaySignature(body, header(body, "unknown-kid"), keys), false);
  assert.equal(await verifyEbaySignature(body, null, keys), false);
  assert.equal(await verifyEbaySignature(body, "not base64 json", keys), false);
});

// --- the purge ------------------------------------------------------------------------------

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "sigpath-ebay-del-"));
  const key = randomBytes(32);
  const w = {
    dir,
    metaStore: OrderMetaStore.withKey(join(dir, "meta"), key),
    reportStore: ReportStore.withKey(join(dir, "reports"), key),
    decisions: new DecisionLog(join(dir, "decisions.json")),
    cases: new CaseLog(join(dir, "cases.json")),
    verified: new VerifiedSellerLog(join(dir, "verified.json")),
  };
  const order = () => Keypair.generate().publicKey.toBase58();
  const listing = { source: "ebay", id: "1", url: "https://www.ebay.de/itm/1", title: "Boots", amount: 100, currency: "EUR" };
  const seed = async (handle: string) => {
    const o1 = order();
    const o2 = order();
    await w.metaStore.put(o1, { buyer: "B", seller: { source: "ebay", handle }, listing });
    await w.reportStore.put(o2, {
      order: o2,
      buyer: "B",
      seller: { source: "ebay", handle },
      listing,
      category: "counterfeit",
      description: "Not genuine at all.",
      evidence: { imageBase64: "", mediaType: "image/jpeg", sha256: "ab", observed: "", confidence: 1 },
    });
    await w.cases.open(o2, `ebay:${handle.toLowerCase()}`, 1);
    await w.cases.respond(o2, "reply", { text: `My own words, ${handle}.`, at: 2 });
    const o3 = order();
    await w.decisions.record(o3, { status: "upheld", sellerKey: `ebay:${handle.toLowerCase()}`, category: "counterfeit", decidedAt: 3, evidenceSha256: "ab", listingHash: "cd", index: 0, attestation: "A" });
    await w.verified.record(`ebay:${handle.toLowerCase()}`, { wallet: "W", attestation: "A", mint: "M", tokenAccount: "T", proof: { source: "ebay", listingId: "1" }, verifiedAt: 1, expiresAt: 9e9 });
    return { o1, o2, o3 };
  };
  return { w, seed };
}

test("a deleted eBay user's records are removed or pseudonymised — and no one else's are touched", async () => {
  const { w, seed } = await world();
  const gone = await seed("Fake_Goods_24");
  const kept = await seed("Honest_Boots");
  const burned: string[] = [];
  const r = await purgeEbayUser("fake_goods_24", { ...w, revokeBadge: async (k) => (burned.push(k), { revoked: true }) });

  assert.deepEqual(r, { orderRecords: 1, pendingReports: 1, cases: 1, decisions: 1, badge: "burned" });
  assert.equal(await w.metaStore.get(gone.o1), null);
  assert.equal(await w.reportStore.has(gone.o2), false);
  assert.equal(await w.cases.get(gone.o2), null, "their reply, their own words, is gone");
  assert.equal((await w.decisions.get(gone.o3))?.sellerKey, deletedPseudonym("ebay:fake_goods_24"));
  assert.equal(await w.verified.get("ebay:fake_goods_24"), null);
  assert.deepEqual(burned, ["ebay:fake_goods_24"]);

  // The handle appears nowhere SigPath keeps in the clear.
  for (const f of ["decisions.json", "cases.json", "verified.json"]) {
    assert.ok(!readFileSync(join(w.dir, f), "utf8").toLowerCase().includes("fake_goods_24"), f);
  }
  // Everyone else is untouched.
  assert.ok(await w.metaStore.get(kept.o1));
  assert.ok(await w.reportStore.has(kept.o2));
  assert.equal((await w.cases.get(kept.o2))?.reply?.text, "My own words, Honest_Boots.");
  assert.equal((await w.decisions.get(kept.o3))?.sellerKey, "ebay:honest_boots");
  assert.ok(await w.verified.get("ebay:honest_boots"));
});

test("eBay retries notices: a second purge finds nothing and changes nothing", async () => {
  const { w, seed } = await world();
  await seed("Fake_Goods_24");
  await purgeEbayUser("Fake_Goods_24", w);
  assert.deepEqual(await purgeEbayUser("Fake_Goods_24", w), { orderRecords: 0, pendingReports: 0, cases: 0, decisions: 0, badge: "none" });
});

test("a badge whose burn fails still loses its record, and the report says so", async () => {
  const { w, seed } = await world();
  await seed("Fake_Goods_24");
  const r = await purgeEbayUser("Fake_Goods_24", { ...w, revokeBadge: async () => ({ revoked: true, chainError: "rpc down" }) });
  assert.equal(r.badge, "record deleted, burn failed");
  assert.equal(await w.verified.get("ebay:fake_goods_24"), null);
});

test("an unknown user is a no-op", async () => {
  const { w } = await world();
  assert.deepEqual(await purgeEbayUser("never_seen", w), { orderRecords: 0, pendingReports: 0, cases: 0, decisions: 0, badge: "none" });
});

// --- streaming search -----------------------------------------------------------------------

test("startSearch gives one promise per source, each resolving as that source answers", async () => {
  const order: string[] = [];
  const slow: MarketplaceSource = { id: "ebay", search: async () => (await new Promise((r) => setTimeout(r, 60)), order.push("ebay"), { source: "ebay", status: "ok", listings: [] }) };
  const fast: MarketplaceSource = { id: "etsy", priceComparable: false, search: async () => (order.push("etsy"), { source: "etsy", status: "ok", listings: [] }) };
  const pending = startSearch("x", [slow, fast]);
  assert.equal(pending.length, 2);
  const first = await Promise.race(pending.map((p, i) => p.then(() => i)));
  assert.equal(first, 1, "the fast source can be shown before the slow one answers");
  const [a, b] = await Promise.all(pending);
  assert.equal(a.comparable, true);
  assert.equal(b.comparable, false);
  assert.deepEqual(order, ["etsy", "ebay"]);
});

test("a source that throws becomes a typed error, never a rejected promise", async () => {
  const broken: MarketplaceSource = { id: "ebay", search: async () => { throw new Error("boom"); } };
  const [r] = startSearch("x", [broken]);
  const res = await r;
  assert.equal(res.status, "error");
  assert.match(res.detail ?? "", /source threw: boom/);
});

test("assembling the streamed results gives exactly what searchAll gives", async () => {
  const sources = [new StubSource()];
  const viaStream = assembleSearch("thinkpad", await Promise.all(startSearch("thinkpad", sources, { limit: 20 })), { limit: 20 });
  const viaAll = await searchAll("thinkpad", sources, { limit: 20 });
  assert.deepEqual(viaStream, viaAll);
});

test("the demo feed can be told to answer slowly, for showing streaming without live keys", async () => {
  const t = Date.now();
  await new StubSource("EUR", 80).search("x");
  assert.ok(Date.now() - t >= 70);
});
