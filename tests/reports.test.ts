import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import nacl from "tweetnacl";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as orders from "../lib/chains/solana/orders";
import {
  DecisionLog,
  ReportStore,
  checkReportable,
  createReportIntent,
  verifyIntentSignature,
  bindEvidenceSession,
  submitReport,
  decideReport,
  expireStaleReports,
  reportMessage,
  reverseDecision,
  PENDING_REPORT_MAX_SECS,
  _clearIntents,
  type ReportDeps,
} from "../lib/reports/reports";
import { OrderMetaStore, REPORT_WINDOW_SECS, ORDER_META_RETENTION_SECS, type OrderMeta } from "../lib/reports/order-meta";
import { CaseLog } from "../lib/reports/cases";
import { signSellerToken, verifySellerToken, sellerLink } from "../lib/reports/seller-access";
import { sellerFindings, publicFindings, respondAsSeller } from "../lib/reports/seller";
import { AddressStore } from "../lib/checkout/address-store";
import { buildChallenge } from "../lib/challenge/generate";
import { VisionLivenessProvider } from "../lib/liveness/vision";
import { reportNonce, reversalNonce } from "../lib/chains/solana/sas-reports";
import { upheldReportFlags, searchAll } from "../lib/marketplace/search";
import { StubSource } from "../lib/marketplace/sources/stub";
import { sellerKey } from "../lib/marketplace/types";
import { checkoutEligibility } from "../lib/checkout/eligibility";
import { signQuote, verifyQuote } from "../lib/checkout/quote";
import { prepareCheckout } from "../lib/checkout/checkout";
import type { ChallengeVerification } from "../lib/challenge/verify";

/**
 * A false report is as harmful as a fake product — it damages an honest
 * seller, and in Germany accusing someone of selling counterfeits without
 * solid grounds is a legal problem. So most of these tests are about what must
 * NOT happen: a report from someone who didn't buy, evidence that isn't theirs,
 * a capture from another purpose, anything public before a reviewer decides,
 * and buyer data surviving the decision.
 */

beforeEach(() => _clearIntents());

const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);

function orderAccount(o: { status: number; buyer: PublicKey; settledAt?: number }): Buffer {
  const b = Buffer.alloc(orders.ORDER_LAYOUT.size);
  orders.ORDER_ACCOUNT_DISCRIMINATOR.copy(b, 0);
  o.buyer.toBuffer().copy(b, orders.ORDER_LAYOUT.buyer);
  b.writeUInt8(o.status, orders.ORDER_LAYOUT.status);
  b.writeBigInt64LE(BigInt(o.settledAt ?? NOW_S - 86400), orders.ORDER_LAYOUT.settledAt);
  return b;
}

function conn(account: Buffer | null): Connection {
  return {
    getAccountInfo: async () =>
      account ? { owner: orders.ORDERS_PROGRAM_ID, data: account, executable: false, lamports: 1 } : null,
  } as unknown as Connection;
}

const META: OrderMeta = {
  buyer: "",
  seller: { source: "ebay", handle: "Fake_Goods_24" },
  listing: { source: "ebay", id: "v1|9|0", url: "https://www.ebay.de/itm/9", title: "Designer bag", amount: 4900, currency: "EUR" },
};

async function world(opts: { status?: number; settledAt?: number; withMeta?: boolean } = {}) {
  const key = randomBytes(32);
  const root = mkdtempSync(join(tmpdir(), "sigpath-reports-"));
  const buyer = Keypair.generate();
  const order = Keypair.generate().publicKey.toBase58();
  const metaStore = OrderMetaStore.withKey(join(root, "meta"), key);
  const reportStore = ReportStore.withKey(join(root, "pending"), key);
  const decisions = new DecisionLog(join(root, "decisions.json"));
  const cases = new CaseLog(join(root, "cases.json"));
  if (opts.withMeta !== false) await metaStore.put(order, { ...META, buyer: buyer.publicKey.toBase58() });
  const deps: ReportDeps = {
    conn: conn(orderAccount({ status: opts.status ?? 1, buyer: buyer.publicKey, settledAt: opts.settledAt })),
    metaStore,
    reportStore,
    decisions,
    cases,
    now: NOW,
  };
  return { root, key, buyer, order, deps, metaStore, reportStore, decisions, cases };
}

function sign(kp: Keypair, message: string): string {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)).toString("base64");
}

const passes = async (): Promise<ChallengeVerification> => ({ passed: true, confidence: 0.95, observed: "a bag beside a note reading 7K4M", failureReason: "" });

/** Walk the whole buyer path up to a bound evidence session. */
async function signedIntent(w: Awaited<ReturnType<typeof world>>) {
  const i = await createReportIntent({ order: w.order, wallet: w.buyer.publicKey.toBase58() }, w.deps);
  assert.ok(i.ok, !i.ok ? i.error : "");
  if (!i.ok) throw new Error();
  assert.ok(verifyIntentSignature(i.intentId, sign(w.buyer, i.message), NOW).ok);
  const sessionId = "session-" + randomBytes(4).toString("hex");
  assert.ok(bindEvidenceSession(i.intentId, sessionId, NOW).ok);
  return { intentId: i.intentId, sessionId };
}

const GOOD = { imageBase64: Buffer.from("jpeg-bytes").toString("base64"), mediaType: "image/jpeg", category: "counterfeit", description: "Stitching is wrong and the serial doesn't exist." };

// ---------------------------------------------------------------------------
// Who can report
// ---------------------------------------------------------------------------

test("only a fulfilled order can be reported", async () => {
  for (const [status, re] of [[0, /hasn't been fulfilled/], [2, /refunded/]] as const) {
    const w = await world({ status });
    const r = await checkReportable(w.order, null, w.deps);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", re);
  }
});

test("only the wallet that paid can report", async () => {
  const w = await world();
  const r = await checkReportable(w.order, Keypair.generate().publicKey.toBase58(), w.deps);
  assert.equal(!r.ok && r.status, 403);
});

test("the report window closes 30 days after fulfilment", async () => {
  const w = await world({ settledAt: NOW_S - REPORT_WINDOW_SECS - 60 });
  const r = await checkReportable(w.order, null, w.deps);
  assert.match(!r.ok ? r.error : "", /window/);
});

test("an order with no seller record cannot be reported against anyone", async () => {
  const w = await world({ withMeta: false });
  const r = await checkReportable(w.order, null, w.deps);
  assert.match(!r.ok ? r.error : "", /no record of who sold/);
});

// ---------------------------------------------------------------------------
// Proving you are the buyer
// ---------------------------------------------------------------------------

test("the signed message names the order, the wallet and its purpose", () => {
  const m = reportMessage("ORDER123", "WALLET456", "nonce", "2026-09-29T00:00:00.000Z");
  assert.match(m, /fake-product report/);
  assert.match(m, /ORDER123/);
  assert.match(m, /WALLET456/);
});

test("a signature from any other key is refused", async () => {
  const w = await world();
  const i = await createReportIntent({ order: w.order, wallet: w.buyer.publicKey.toBase58() }, w.deps);
  if (!i.ok) throw new Error(i.error);
  const r = verifyIntentSignature(i.intentId, sign(Keypair.generate(), i.message), NOW);
  assert.equal(!r.ok && r.status, 403);
});

test("the buyer's signature over a DIFFERENT message is refused", async () => {
  // A signature from some other site's "sign to log in" prompt must not carry over.
  const w = await world();
  const i = await createReportIntent({ order: w.order, wallet: w.buyer.publicKey.toBase58() }, w.deps);
  if (!i.ok) throw new Error(i.error);
  const r = verifyIntentSignature(i.intentId, sign(w.buyer, "Sign in to example.com"), NOW);
  assert.equal(r.ok, false);
});

test("no camera challenge before the signature is verified", async () => {
  const w = await world();
  const i = await createReportIntent({ order: w.order, wallet: w.buyer.publicKey.toBase58() }, w.deps);
  if (!i.ok) throw new Error(i.error);
  assert.equal(bindEvidenceSession(i.intentId, "s", NOW).ok, false);
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test("evidence challenges always use the handwritten code", () => {
  // The other item kinds are weaker ("next to something blue": six answers).
  for (let i = 0; i < 100; i++) {
    const c = buildChallenge("evidence");
    assert.equal(c.kind, "code");
    assert.equal(c.subject, "evidence");
    assert.match(c.instruction, /item you received/);
  }
});

test("an evidence capture cannot be spent as an identity pass, or vice versa", async () => {
  // THE CROSS-USE THIS CLOSES. An evidence photo is a code beside an object —
  // no face. Accepted by the identity route, it would earn LIVE_CAPTURE.
  const evidence = new VisionLivenessProvider("evidence");
  const identity = new VisionLivenessProvider("person");
  const e = await evidence.createSession("x");
  const p = await identity.createSession("x");

  const cross1 = await identity.verify(e.sessionId, { imageBase64: "aGk=", mediaType: "image/jpeg" });
  assert.match(cross1.unavailable ?? "", /Unknown/);
  const cross2 = await evidence.verify(p.sessionId, { imageBase64: "aGk=", mediaType: "image/jpeg" });
  assert.match(cross2.unavailable ?? "", /Unknown/);
});

test("a capture from outside this report is refused", async () => {
  const w = await world();
  const { intentId } = await signedIntent(w);
  const r = await submitReport({ intentId, sessionId: "someone-elses", ...GOOD }, { ...w.deps, verify: passes });
  assert.equal(!r.ok && r.status, 403);
});

test("a photo that fails the check files nothing", async () => {
  const w = await world();
  const { intentId, sessionId } = await signedIntent(w);
  const r = await submitReport(
    { intentId, sessionId, ...GOOD },
    { ...w.deps, verify: async () => ({ passed: false, confidence: 0.9, observed: "", failureReason: "wrong code" }) },
  );
  assert.ok(r.ok && !r.passed);
  assert.equal(await w.reportStore.has(w.order), false);
});

test("an outage is not a failed photo", async () => {
  const w = await world();
  const { intentId, sessionId } = await signedIntent(w);
  const r = await submitReport(
    { intentId, sessionId, ...GOOD },
    { ...w.deps, verify: async () => ({ passed: false, confidence: 0, observed: "", failureReason: "", unavailable: "model down" }) },
  );
  assert.equal(!r.ok && r.status, 503);
});

test("category and description are required", async () => {
  const w = await world();
  const { intentId, sessionId } = await signedIntent(w);
  assert.equal((await submitReport({ intentId, sessionId, ...GOOD, category: "bad" }, { ...w.deps, verify: passes })).ok, false);
  assert.equal((await submitReport({ intentId, sessionId, ...GOOD, description: "fake" }, { ...w.deps, verify: passes })).ok, false);
});

test("a passing report is filed encrypted, with the seller from the order", async () => {
  const w = await world();
  const { intentId, sessionId } = await signedIntent(w);
  const r = await submitReport({ intentId, sessionId, ...GOOD }, { ...w.deps, verify: passes });
  assert.ok(r.ok && r.passed);

  const got = await w.reportStore.get(w.order);
  assert.equal(got?.record.seller.handle, "Fake_Goods_24", "the seller comes from checkout, not the reporter");
  assert.equal(got?.record.evidence.sha256.length, 64);

  const raw = readdirSync(join(w.root, "pending")).map((f) => readFileSync(join(w.root, "pending", f), "utf8")).join("");
  for (const leak of ["Stitching", w.buyer.publicKey.toBase58(), "Fake_Goods_24"]) {
    assert.ok(!raw.includes(leak), `"${leak}" readable on disk`);
  }
});

test("an order can be reported once", async () => {
  const w = await world();
  const a = await signedIntent(w);
  assert.ok((await submitReport({ ...a, ...GOOD }, { ...w.deps, verify: passes })).ok);
  const again = await createReportIntent({ order: w.order, wallet: w.buyer.publicKey.toBase58() }, w.deps);
  assert.match(!again.ok ? again.error : "", /already been reported/);
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * A filed report whose seller was notified eight days ago and never replied —
 * the reply window has closed, so it can be decided. Tests about the window
 * itself set their own notice times.
 */
async function filed(opts: { notified?: boolean } = {}) {
  const w = await world();
  const s = await signedIntent(w);
  const r = await submitReport({ ...s, ...GOOD }, { ...w.deps, verify: passes });
  assert.ok(r.ok && r.passed);
  if (opts.notified !== false) await w.cases.markNotified(w.order, NOW_S - 8 * 86400);
  return w;
}

test("nothing is public while a report is pending", async () => {
  const w = await filed();
  assert.equal((await w.decisions.upheldCounts()).size, 0);
});

test("upholding publishes first, then records, then deletes the buyer's data", async () => {
  const w = await filed();
  const r = await decideReport(w.order, "upheld", {
    cases: w.cases,
    reportStore: w.reportStore,
    decisions: w.decisions,
    publish: async () => ({ attestation: "AttestationAddr", index: 0 }),
  });
  assert.ok(r.ok);
  assert.equal(r.ok && r.decision.attestation, "AttestationAddr");
  assert.equal((await w.decisions.upheldCounts()).get(sellerKey("ebay", "Fake_Goods_24")), 1);
  assert.equal(await w.reportStore.has(w.order), false, "photo, words and wallet are gone");

  const log = readFileSync(join(w.root, "decisions.json"), "utf8");
  assert.ok(!log.includes(w.buyer.publicKey.toBase58()), "the decision log holds nothing about the buyer");
  assert.ok(!log.includes("Stitching"));
});

test("if publishing fails, nothing is recorded and the report stays pending", async () => {
  // The local count and the chain must never disagree.
  const w = await filed();
  const r = await decideReport(w.order, "upheld", {
    cases: w.cases,
    reportStore: w.reportStore,
    decisions: w.decisions,
    publish: async () => ({ error: "rpc down" }),
  });
  assert.equal(r.ok, false);
  assert.equal(await w.reportStore.has(w.order), true);
  assert.equal((await w.decisions.upheldCounts()).size, 0);
});

test("the chain's index is what gets recorded, not the local count", async () => {
  const w = await filed();
  const r = await decideReport(w.order, "upheld", {
    cases: w.cases,
    reportStore: w.reportStore,
    decisions: w.decisions,
    publish: async (_r, localIndex) => {
      assert.equal(localIndex, 0);
      return { attestation: "A", index: 3 }; // e.g. another instance published before
    },
  });
  assert.equal(r.ok && r.decision.index, 3);
});

test("dismissing publishes nothing and still deletes the buyer's data", async () => {
  const w = await filed();
  let published = false;
  const r = await decideReport(w.order, "dismissed", {
    reportStore: w.reportStore,
    decisions: w.decisions,
    publish: async () => {
      published = true;
      return { attestation: "x", index: 0 };
    },
  });
  assert.ok(r.ok);
  assert.equal(published, false);
  assert.equal((await w.decisions.upheldCounts()).size, 0);
  assert.equal(await w.reportStore.has(w.order), false);
});

test("a decision is final", async () => {
  const w = await filed();
  await decideReport(w.order, "dismissed", { reportStore: w.reportStore, decisions: w.decisions });
  const again = await decideReport(w.order, "upheld", { reportStore: w.reportStore, decisions: w.decisions });
  assert.equal(again.ok, false);
});

test("an unreviewed report expires rather than being kept forever", async () => {
  const w = await filed();
  const later = NOW + (PENDING_REPORT_MAX_SECS + 60) * 1000;
  const expired = await expireStaleReports({ reportStore: w.reportStore, decisions: w.decisions, now: later });
  assert.deepEqual(expired, [w.order]);
  assert.equal((await w.decisions.get(w.order))?.status, "expired");
  assert.equal((await w.decisions.upheldCounts()).size, 0, "expiry is not a finding against the seller");
});

// ---------------------------------------------------------------------------
// The penalty
// ---------------------------------------------------------------------------

test("an upheld report flags every listing from that seller, and blocks checkout", () => {
  const listing = { id: "1", source: "stub" as const, title: "t", url: "u", price: { amount: 100, currency: "EUR" }, shipping: { amount: 0, currency: "EUR" }, condition: "new" as const, seller: { handle: "Bad_Seller" } };
  const flags = upheldReportFlags([listing], new Map([[sellerKey("stub", "bad_seller"), 2]]));
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /2 verified buyers/);
  assert.equal(checkoutEligibility(listing, flags, { checked: true }).eligible, false);
});

test("seller identity ignores case and whitespace, like subjectHash", () => {
  assert.equal(sellerKey("eBay", "  Bad_Seller "), sellerKey("ebay", "bad_seller"));
});

test("search flags the reported seller's listings end to end", async () => {
  const r = await searchAll("thinkpad x1", [new StubSource()], { limit: 20 }, { upheldReports: new Map([["stub:long_time_seller", 1]]) });
  const flagged = r.analysis.flags.filter((f) => f.kind === "upheld_reports").map((f) => f.listingId);
  assert.deepEqual(flagged, ["stub-used-bait"]);
});

test("checkout refuses a seller whose report was upheld after the quote was signed", async () => {
  const env = { QUOTE_SECRET: "q".repeat(40) };
  const quote = signQuote({ source: "ebay", id: "1", url: "u", title: "t", seller: "Bad_Seller", amount: 100, currency: "USD" }, env)!;
  const r = await prepareCheckout(
    { quote, buyer: Keypair.generate().publicKey.toBase58(), address: {} },
    { env, store: AddressStore.withKey(mkdtempSync(join(tmpdir(), "a-")), randomBytes(32)), upheldReports: new Map([["ebay:bad_seller", 1]]) },
  );
  assert.equal(!r.ok && r.status, 409);
});

test("a quote with an empty seller is refused — a report must land on someone", () => {
  const env = { QUOTE_SECRET: "q".repeat(40) };
  const token = signQuote({ source: "ebay", id: "1", url: "u", title: "t", seller: "", amount: 100, currency: "USD" }, env)!;
  assert.equal(verifyQuote(token, env).ok, false);
});

// ---------------------------------------------------------------------------
// On chain: findable from the handle alone
// ---------------------------------------------------------------------------

test("report nonces are deterministic, per seller and per index", () => {
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);
  assert.equal(reportNonce(a, 0), reportNonce(a, 0));
  assert.notEqual(reportNonce(a, 0), reportNonce(a, 1));
  assert.notEqual(reportNonce(a, 0), reportNonce(b, 0));
  assert.throws(() => reportNonce(Buffer.alloc(31), 0));
  assert.throws(() => reportNonce(a, -1));
});

// ---------------------------------------------------------------------------
// Order records
// ---------------------------------------------------------------------------

test("order records are swept on the report schedule", async () => {
  const w = await world();
  const view = (v: Parameters<OrderMetaStore["sweep"]>[0] extends (o: string) => Promise<infer R> ? R : never) => async () => v;

  assert.deepEqual(await w.metaStore.sweep(view({ status: "fulfilled", settledAt: NOW_S - 86400 }), NOW), [], "inside the window");
  assert.equal((await w.metaStore.sweep(view({ status: "fulfilled", settledAt: NOW_S - REPORT_WINDOW_SECS - 60 }), NOW))[0]?.reason, "report window closed");
});

test("refunded orders and the retention cap clear order records", async () => {
  const a = await world();
  assert.equal((await a.metaStore.sweep(async () => ({ status: "refunded", settledAt: NOW_S }), NOW))[0]?.reason, "order refunded");
  const b = await world();
  const later = NOW + (ORDER_META_RETENTION_SECS + 60) * 1000;
  assert.equal((await b.metaStore.sweep(async () => "unknown", later))[0]?.reason, "retention limit reached");
});

test("a record copied between stores will not decrypt, even under the same key", async () => {
  // Purpose is bound into the authenticated data.
  const key = randomBytes(32);
  const root = mkdtempSync(join(tmpdir(), "sigpath-purpose-"));
  const order = Keypair.generate().publicKey.toBase58();
  const addresses = AddressStore.withKey(join(root, "addr"), key);
  await addresses.put(order, { address: { name: "A", line1: "B", postcode: "1", city: "C", country: "DE" }, buyer: "x", listing: META.listing, usdc: "1" });
  mkdirSync(join(root, "meta"), { recursive: true });
  copyFileSync(join(root, "addr", `${order}.json`), join(root, "meta", `${order}.json`));
  await assert.rejects(OrderMetaStore.withKey(join(root, "meta"), key).get(order));
});

// ---------------------------------------------------------------------------
// The seller's right of reply
// ---------------------------------------------------------------------------

const SECRET_ENV = { QUOTE_SECRET: "s".repeat(40) };
const SELLER = sellerKey("ebay", "Fake_Goods_24");

test("a report opens the seller's side of the case when it is filed", async () => {
  const w = await filed({ notified: false });
  const c = await w.cases.get(w.order);
  assert.equal(c?.sellerKey, SELLER);
  assert.equal(c?.notifiedAt, undefined);
});

test("a report cannot be upheld before the seller is notified", async () => {
  const w = await filed({ notified: false });
  const r = await decideReport(w.order, "upheld", { reportStore: w.reportStore, decisions: w.decisions, cases: w.cases, now: NOW });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /hasn't been notified/);
});

test("a notified seller has seven days before a report can be upheld without them", async () => {
  const w = await filed({ notified: false });
  await w.cases.markNotified(w.order, NOW_S - 2 * 86400);
  const r = await decideReport(w.order, "upheld", { reportStore: w.reportStore, decisions: w.decisions, cases: w.cases, now: NOW });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /5 days left/);
  assert.equal(await w.reportStore.has(w.order), true, "still pending");
});

test("a seller's reply ends the wait — the reviewer has their answer", async () => {
  const w = await filed({ notified: false });
  await w.cases.markNotified(w.order, NOW_S - 86400);
  await w.cases.respond(w.order, "reply", { text: "This is a genuine item, here is the invoice number.", at: NOW_S });
  const r = await decideReport(w.order, "upheld", {
    reportStore: w.reportStore,
    decisions: w.decisions,
    cases: w.cases,
    now: NOW,
    publish: async () => ({ attestation: "A", index: 0 }),
  });
  assert.ok(r.ok);
});

test("a report can be DISMISSED at any time, notice or not", async () => {
  // An obviously unfounded report needs no reply to reject.
  const w = await filed({ notified: false });
  const r = await decideReport(w.order, "dismissed", { reportStore: w.reportStore, decisions: w.decisions, now: NOW });
  assert.ok(r.ok);
});

test("re-sending the notice does not restart the reply window", async () => {
  const w = await filed({ notified: false });
  await w.cases.markNotified(w.order, 1000);
  const c = await w.cases.markNotified(w.order, 2000);
  assert.equal(c.notifiedAt, 1000);
});

// --- links -------------------------------------------------------------------

test("a seller link verifies, and names its seller", () => {
  const t = signSellerToken(SELLER, SECRET_ENV)!;
  const v = verifySellerToken(t, SECRET_ENV);
  assert.ok(v.ok && v.sellerKey === SELLER);
});

test("a tampered, expired or foreign link is refused", () => {
  const t = signSellerToken(SELLER, SECRET_ENV)!;
  assert.equal(verifySellerToken(t.slice(0, -2) + "xx", SECRET_ENV).ok, false);
  assert.equal(verifySellerToken(signSellerToken(SELLER, SECRET_ENV, NOW, -1), SECRET_ENV).ok, false);
  assert.equal(verifySellerToken(signSellerToken(SELLER, { QUOTE_SECRET: "o".repeat(40) }), SECRET_ENV).ok, false);
});

test("a price quote cannot pass as a seller link, though they share a secret", () => {
  const quote = signQuote({ source: "ebay", id: "1", url: "u", title: "t", seller: "x", amount: 1, currency: "USD" }, SECRET_ENV)!;
  assert.equal(verifySellerToken(quote, SECRET_ENV).ok, false);
});

test("the link carries its token in the fragment, which browsers never send to a server", () => {
  const link = sellerLink("https://sigpath.example/", "TOKEN");
  assert.equal(link, "https://sigpath.example/seller/respond#t=TOKEN");
  assert.ok(!link.includes("?"));
});

// --- what the seller sees and says ---------------------------------------------

test("the seller sees a pending report's substance, never the buyer's photo or wallet", async () => {
  const w = await filed();
  const [f] = await sellerFindings(SELLER, w);
  assert.equal(f.status, "pending");
  assert.match(f.buyerDescription ?? "", /Stitching/);
  assert.equal(f.listing?.url, META.listing.url);
  assert.equal(f.canReply, true);
  const json = JSON.stringify(f);
  assert.ok(!json.includes(w.buyer.publicKey.toBase58()), "no wallet");
  assert.ok(!json.includes(GOOD.imageBase64), "no photo");
});

test("a link only answers reports about its own seller", async () => {
  const w = await filed();
  const other = signSellerToken(sellerKey("ebay", "someone_else"), SECRET_ENV);
  const r = await respondAsSeller({ token: other, order: w.order, text: "This isn't about me at all." }, { ...w, env: SECRET_ENV });
  assert.equal(!r.ok && r.status, 404);
});

test("before a decision the seller replies; the reply is write-once", async () => {
  const w = await filed();
  const token = signSellerToken(SELLER, SECRET_ENV);
  const r = await respondAsSeller({ token, order: w.order, text: "Genuine stock, bought from the brand's distributor." }, { ...w, env: SECRET_ENV });
  assert.ok(r.ok && r.kind === "reply");
  const again = await respondAsSeller({ token, order: w.order, text: "Actually, a different story now." }, { ...w, env: SECRET_ENV });
  assert.equal(!again.ok && again.status, 409);
});

test("after an upheld finding the seller can appeal; after a dismissal there is nothing to answer", async () => {
  const token = signSellerToken(SELLER, SECRET_ENV);

  const up = await filed();
  await decideReport(up.order, "upheld", { reportStore: up.reportStore, decisions: up.decisions, cases: up.cases, now: NOW, publish: async () => ({ attestation: "A", index: 0 }) });
  const appeal = await respondAsSeller({ token, order: up.order, text: "The buyer returned a different item." }, { ...up, env: SECRET_ENV });
  assert.ok(appeal.ok && appeal.kind === "appeal");

  const dis = await filed();
  await decideReport(dis.order, "dismissed", { reportStore: dis.reportStore, decisions: dis.decisions, now: NOW });
  const none = await respondAsSeller({ token, order: dis.order, text: "Thank you for reviewing this." }, { ...dis, env: SECRET_ENV });
  assert.equal(!none.ok && none.status, 409);
});

test("an invalid link or a too-short response is refused", async () => {
  const w = await filed();
  assert.equal((await respondAsSeller({ token: "nope", order: w.order, text: "long enough text" }, { ...w, env: SECRET_ENV })).ok, false);
  const t = signSellerToken(SELLER, SECRET_ENV);
  assert.equal((await respondAsSeller({ token: t, order: w.order, text: "short" }, { ...w, env: SECRET_ENV })).ok, false);
});

// --- what the public sees -------------------------------------------------------

test("the public page never shows a pending report", async () => {
  const w = await filed();
  assert.deepEqual(await publicFindings(SELLER, w), []);
});

test("an upheld finding is public with the seller's reply beside it", async () => {
  const w = await filed({ notified: false });
  await w.cases.markNotified(w.order, NOW_S - 86400);
  await w.cases.respond(w.order, "reply", { text: "We dispute this.", at: NOW_S });
  await decideReport(w.order, "upheld", { reportStore: w.reportStore, decisions: w.decisions, cases: w.cases, now: NOW, publish: async () => ({ attestation: "A", index: 0 }) });
  const [f] = await publicFindings(SELLER, w);
  assert.equal(f.status, "upheld");
  assert.equal(f.reply?.text, "We dispute this.");
});

// --- reversal -------------------------------------------------------------------

async function upheld() {
  const w = await filed();
  const r = await decideReport(w.order, "upheld", { reportStore: w.reportStore, decisions: w.decisions, cases: w.cases, now: NOW, publish: async () => ({ attestation: "A", index: 0 }) });
  assert.ok(r.ok);
  return w;
}

test("a reversal publishes first, then stops the finding counting — without deleting it", async () => {
  const w = await upheld();
  assert.equal((await w.decisions.upheldCounts()).get(SELLER), 1);
  const r = await reverseDecision(w.order, { decisions: w.decisions, now: NOW, publishReversal: async () => ({ attestation: "R" }) });
  assert.ok(r.ok && r.decision.reversal?.attestation === "R");
  assert.equal((await w.decisions.upheldCounts()).get(SELLER), undefined, "the flag and checkout ban lift");
  const [f] = await publicFindings(SELLER, w);
  assert.equal(f.status, "reversed", "still listed, marked reversed");
});

test("if the reversal can't be published, nothing changes", async () => {
  const w = await upheld();
  const r = await reverseDecision(w.order, { decisions: w.decisions, publishReversal: async () => ({ error: "rpc down" }) });
  assert.equal(r.ok, false);
  assert.equal((await w.decisions.upheldCounts()).get(SELLER), 1);
});

test("only an upheld finding can be reversed, and only once", async () => {
  const w = await upheld();
  assert.ok((await reverseDecision(w.order, { decisions: w.decisions })).ok);
  assert.equal((await reverseDecision(w.order, { decisions: w.decisions })).ok, false);
  const d = await filed();
  await decideReport(d.order, "dismissed", { reportStore: d.reportStore, decisions: d.decisions });
  assert.equal((await reverseDecision(d.order, { decisions: d.decisions })).ok, false);
});

test("a reversal lives at a derivable address, distinct from the report it reverses", () => {
  const s = Buffer.alloc(32, 7);
  assert.equal(reversalNonce(s, 1), reversalNonce(s, 1));
  assert.notEqual(reversalNonce(s, 1), reportNonce(s, 1));
  assert.notEqual(reversalNonce(s, 1), reversalNonce(s, 2));
});

// ---------------------------------------------------------------------------
// The verified-seller badge and upheld reports
// ---------------------------------------------------------------------------

test("upholding a report revokes the seller's verified badge, after the decision is recorded", async () => {
  const w = await filed();
  const calls: string[] = [];
  const r = await decideReport(w.order, "upheld", {
    cases: w.cases,
    reportStore: w.reportStore,
    decisions: w.decisions,
    publish: async () => ({ attestation: "A", index: 0 }),
    revokeBadge: async (key) => {
      calls.push(key);
      assert.ok(await w.decisions.get(w.order), "the decision is already recorded when revocation runs");
      return { revoked: true, signature: "BurnSig" };
    },
  });
  assert.ok(r.ok && r.badge?.revoked && r.badge.signature === "BurnSig");
  assert.deepEqual(calls, [sellerKey("ebay", "Fake_Goods_24")]);
});

test("a failed revocation never undoes the finding", async () => {
  const w = await filed();
  const r = await decideReport(w.order, "upheld", {
    cases: w.cases,
    reportStore: w.reportStore,
    decisions: w.decisions,
    publish: async () => ({ attestation: "A", index: 0 }),
    revokeBadge: async () => {
      throw new Error("rpc down");
    },
  });
  assert.ok(r.ok && r.badge?.chainError === "rpc down");
  assert.equal((await w.decisions.upheldCounts()).get(sellerKey("ebay", "Fake_Goods_24")), 1);
});

test("dismissing a report leaves the badge alone", async () => {
  const w = await filed();
  let called = false;
  const r = await decideReport(w.order, "dismissed", {
    reportStore: w.reportStore,
    decisions: w.decisions,
    revokeBadge: async () => {
      called = true;
      return { revoked: true };
    },
  });
  assert.ok(r.ok);
  assert.equal(called, false);
});
