import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  startClaim,
  proveHandle,
  verifyClaimSignature,
  bindClaimSession,
  completeClaim,
  claimMessage,
  textContainsCode,
  _clearClaimSessions,
  CLAIM_TTL_SECS,
  PROVEN_TTL_SECS,
  claimMarketplaces,
  type ClaimableSource,
} from "../lib/sellers/claim";
import { VerifiedSellerLog, badgeFor, type Badge } from "../lib/sellers/verified-log";
import { stubListingForProof, sellerSubject } from "../lib/sellers/badges";
import { subjectHash } from "../lib/crypto/hash";
import { mintAccountSpace, verifiedNonce } from "../lib/chains/solana/sas-verified";
import { reportNonce } from "../lib/chains/solana/sas-reports";
import { signQuote } from "../lib/checkout/quote";
import { signSellerToken } from "../lib/reports/seller-access";
import type { ListingProof } from "../lib/marketplace/sources/types";
import type { ChallengeVerification } from "../lib/challenge/verify";

const ENV = { QUOTE_SECRET: "q".repeat(40) };
const NOW = Date.UTC(2026, 9, 2, 12);
const NOW_S = Math.floor(NOW / 1000);

beforeEach(() => _clearClaimSessions());

function world(opts: { listing?: (code: string) => ListingProof; upheld?: Map<string, number> } = {}) {
  const wallet = Keypair.generate();
  const log = new VerifiedSellerLog(join(mkdtempSync(join(tmpdir(), "sigpath-sellers-")), "verified.json"));
  const start = startClaim({ wallet: wallet.publicKey.toBase58() }, ENV, NOW);
  assert.ok(start.ok);
  const lookups: { source: ClaimableSource; id: string }[] = [];
  const lookup = async (source: ClaimableSource, id: string): Promise<ListingProof> => {
    lookups.push({ source, id });
    return opts.listing ? opts.listing(start.code) : { ok: true, handle: "Honest_Boots", text: `Genuine leather boots. ${start.code}` };
  };
  const upheld = opts.upheld ?? new Map<string, number>();
  const deps = { env: ENV, now: NOW, lookup, log, upheldCounts: async () => upheld };
  return { wallet, log, start, deps, lookups, upheld };
}

const passes = async (): Promise<ChallengeVerification> => ({ passed: true, confidence: 0.95, observed: "code beside face", failureReason: "" });
const fails = async (): Promise<ChallengeVerification> => ({ passed: false, confidence: 0.2, observed: "", failureReason: "code not visible" });
const issuer = (calls: unknown[] = []) => async (b: { sellerKey: string; wallet: string; verifiedAt: number }) => {
  calls.push(b);
  return { ok: true as const, attestation: "Att111", mint: "Mint111", tokenAccount: "Tok111", expiresAt: b.verifiedAt + 365 * 86400 };
};

async function proven(w: ReturnType<typeof world>) {
  const p = await proveHandle({ claimToken: w.start.claimToken, source: "ebay", listingId: "123456789012" }, w.deps);
  assert.ok(p.ok, !p.ok ? p.error : "");
  return p;
}

async function signedAndBound(w: ReturnType<typeof world>) {
  const p = await proven(w);
  const sig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(p.message), w.wallet.secretKey)).toString("base64");
  const v = verifyClaimSignature({ provenToken: p.provenToken, signature: sig }, ENV, NOW);
  assert.ok(v.ok);
  bindClaimSession(p.provenToken, "session-1", NOW);
  return p;
}

// --- the code and the tokens ------------------------------------------------------

test("a claim issues a readable one-time code bound to the wallet", () => {
  const w = world();
  assert.match(w.start.code, /^SIGPATH-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(w.start.expiresAt, NOW_S + CLAIM_TTL_SECS);
  const other = startClaim({ wallet: Keypair.generate().publicKey.toBase58() }, ENV, NOW);
  assert.ok(other.ok && other.code !== w.start.code, "another wallet gets another code");
});

test("a claim needs QUOTE_SECRET and a real wallet address", () => {
  assert.equal(startClaim({ wallet: Keypair.generate().publicKey.toBase58() }, {}).ok, false);
  assert.equal(startClaim({ wallet: "not-a-wallet" }, ENV).ok, false);
});

test("the code matches however a listing editor spaces or cases it", () => {
  assert.ok(textContainsCode("…boots sigpath abcd efgh…", "SIGPATH-ABCD-EFGH"));
  assert.ok(textContainsCode("<p>SIGPATH-ABCD-EFGH</p>", "SIGPATH-ABCD-EFGH"));
  assert.ok(!textContainsCode("SIGPATH-ABCD-EFGX", "SIGPATH-ABCD-EFGH"));
});

test("claim tokens can't pass as each other, as quotes, or as seller links", async () => {
  const w = world();
  const quote = signQuote({ source: "ebay", id: "1", url: "u", title: "t", seller: "x", amount: 1, currency: "EUR" }, ENV)!;
  const link = signSellerToken("ebay:honest_boots", ENV)!;
  for (const forged of [quote, link, w.start.claimToken.slice(0, -2) + "xx"]) {
    const r = await proveHandle({ claimToken: forged, source: "ebay", listingId: "123456789012" }, w.deps);
    assert.equal(!r.ok && r.status, 401);
  }
  // A claim token where a proven token belongs:
  assert.equal(verifyClaimSignature({ provenToken: w.start.claimToken, signature: "x" }, ENV, NOW).ok, false);
});

test("an expired claim can't be used", async () => {
  const w = world();
  const r = await proveHandle({ claimToken: w.start.claimToken, source: "ebay", listingId: "123456789012" }, { ...w.deps, now: NOW + (CLAIM_TTL_SECS + 1) * 1000 });
  assert.equal(!r.ok && r.status, 401);
});

// --- proving the handle ------------------------------------------------------------

test("the handle comes from the marketplace's answer, never from the claimant", async () => {
  const w = world();
  const p = await proven(w);
  assert.equal(p.sellerKey, "ebay:honest_boots");
  assert.deepEqual(w.lookups, [{ source: "ebay", id: "123456789012" }]);
  assert.equal(p.message, claimMessage("ebay:honest_boots", w.wallet.publicKey.toBase58(), w.start.code));
});

test("a listing without the code proves nothing", async () => {
  const w = world({ listing: () => ({ ok: true, handle: "Honest_Boots", text: "Genuine leather boots." }) });
  const r = await proveHandle({ claimToken: w.start.claimToken, source: "ebay", listingId: "123456789012" }, w.deps);
  assert.equal(!r.ok && r.status, 422);
  assert.match(!r.ok ? r.error : "", /isn't in that listing/);
});

test("a marketplace error is passed on, not treated as proof", async () => {
  const w = world({ listing: () => ({ ok: false, error: "eBay has no live listing with that item number." }) });
  const r = await proveHandle({ claimToken: w.start.claimToken, source: "ebay", listingId: "123456789012" }, w.deps);
  assert.equal(!r.ok && r.status, 422);
});

test("Amazon can't be proved, and the demo marketplace is off when the stub feed is", async () => {
  const w = world();
  const amazon = await proveHandle({ claimToken: w.start.claimToken, source: "amazon", listingId: "B000" }, w.deps);
  assert.equal(!amazon.ok && amazon.status, 400);
  const stubOff = await proveHandle({ claimToken: w.start.claimToken, source: "stub", listingId: "x:y" }, { ...w.deps, env: { ...ENV, STUB_FEED: "false" } });
  assert.equal(!stubOff.ok && stubOff.status, 400);
});

test("the form only offers marketplaces this site can read", () => {
  assert.deepEqual(claimMarketplaces({ EBAY_CLIENT_ID: "a", EBAY_CLIENT_SECRET: "b", STUB_FEED: "false" }), ["ebay"]);
  assert.deepEqual(claimMarketplaces({ EBAY_CLIENT_ID: "a", EBAY_CLIENT_SECRET: "b" }), ["ebay", "stub"]);
  assert.deepEqual(claimMarketplaces({ ETSY_KEYSTRING: "k", ETSY_SHARED_SECRET: "s", STUB_FEED: "false" }), ["etsy"]);
  assert.deepEqual(claimMarketplaces({ EBAY_CLIENT_ID: "a", ETSY_KEYSTRING: "k", STUB_FEED: "false" }), [], "a half-set keyset counts as off");
});

test("a seller with an upheld report can't verify — a penalty can't be papered over", async () => {
  const w = world({ upheld: new Map([["ebay:honest_boots", 1]]) });
  const r = await proveHandle({ claimToken: w.start.claimToken, source: "ebay", listingId: "123456789012" }, w.deps);
  assert.equal(!r.ok && r.status, 409);
  assert.match(!r.ok ? r.error : "", /upheld fake-product report/);
});

test("an account that is already verified can't be claimed again", async () => {
  const w = world();
  await w.log.record("ebay:honest_boots", badge());
  const r = await proveHandle({ claimToken: w.start.claimToken, source: "ebay", listingId: "123456789012" }, w.deps);
  assert.equal(!r.ok && r.status, 409);
});

// --- the wallet signature -------------------------------------------------------------

test("only the claiming wallet's signature unlocks the camera", async () => {
  const w = world();
  const p = await proven(w);
  const msg = new TextEncoder().encode(p.message);
  const forged = Buffer.from(nacl.sign.detached(msg, Keypair.generate().secretKey)).toString("base64");
  assert.equal(verifyClaimSignature({ provenToken: p.provenToken, signature: forged }, ENV, NOW).ok, false);
  const real = Buffer.from(nacl.sign.detached(msg, w.wallet.secretKey)).toString("base64");
  assert.ok(verifyClaimSignature({ provenToken: p.provenToken, signature: real }, ENV, NOW).ok);
});

test("the proven step expires after 30 minutes", async () => {
  const w = world();
  const p = await proven(w);
  const sig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(p.message), w.wallet.secretKey)).toString("base64");
  assert.equal(verifyClaimSignature({ provenToken: p.provenToken, signature: sig }, ENV, NOW + (PROVEN_TTL_SECS + 1) * 1000).ok, false);
});

// --- completing -------------------------------------------------------------------------

test("a passed photo issues the badge to the claiming wallet, and records it", async () => {
  const w = world();
  const p = await signedAndBound(w);
  const calls: { sellerKey: string; wallet: string }[] = [];
  const r = await completeClaim(
    { provenToken: p.provenToken, sessionId: "session-1", imageBase64: "AAAA", mediaType: "image/jpeg" },
    { ...w.deps, verify: passes, issue: issuer(calls) },
  );
  assert.ok(r.ok && r.passed);
  assert.deepEqual(calls.map((c) => [c.sellerKey, c.wallet]), [["ebay:honest_boots", w.wallet.publicKey.toBase58()]]);
  const e = await w.log.get("ebay:honest_boots");
  assert.equal(e?.current.wallet, w.wallet.publicKey.toBase58());
  assert.deepEqual(e?.current.proof, { source: "ebay", listingId: "123456789012" });
});

test("a failed photo issues nothing", async () => {
  const w = world();
  const p = await signedAndBound(w);
  const calls: unknown[] = [];
  const r = await completeClaim(
    { provenToken: p.provenToken, sessionId: "session-1", imageBase64: "AAAA", mediaType: "image/jpeg" },
    { ...w.deps, verify: fails, issue: issuer(calls) },
  );
  assert.ok(r.ok && !r.passed);
  assert.equal(calls.length, 0);
  assert.equal(await w.log.get("ebay:honest_boots"), null);
});

test("a camera session that wasn't unlocked by THIS claim's signature is refused", async () => {
  const w = world();
  const p = await proven(w);
  bindClaimSession("some-other-proven-token", "session-x", NOW);
  const r = await completeClaim(
    { provenToken: p.provenToken, sessionId: "session-x", imageBase64: "AAAA", mediaType: "image/jpeg" },
    { ...w.deps, verify: passes, issue: issuer() },
  );
  assert.equal(!r.ok && r.status, 403);
});

test("a report upheld between the listing check and the photo still blocks the badge", async () => {
  const w = world();
  const p = await signedAndBound(w);
  w.upheld.set("ebay:honest_boots", 1);
  const calls: unknown[] = [];
  const r = await completeClaim(
    { provenToken: p.provenToken, sessionId: "session-1", imageBase64: "AAAA", mediaType: "image/jpeg" },
    { ...w.deps, verify: passes, issue: issuer(calls) },
  );
  assert.equal(!r.ok && r.status, 409);
  assert.equal(calls.length, 0);
});

test("if the chain refuses, nothing is recorded", async () => {
  const w = world();
  const p = await signedAndBound(w);
  const r = await completeClaim(
    { provenToken: p.provenToken, sessionId: "session-1", imageBase64: "AAAA", mediaType: "image/jpeg" },
    { ...w.deps, verify: passes, issue: async () => ({ ok: false as const, error: "rpc down" }) },
  );
  assert.equal(!r.ok && r.status, 502);
  assert.equal(await w.log.get("ebay:honest_boots"), null);
});

// --- showing the badge ---------------------------------------------------------------------

function badge(over: Partial<Badge> = {}): Badge {
  return {
    wallet: "W",
    attestation: "A",
    mint: "M",
    tokenAccount: "T",
    proof: { source: "ebay", listingId: "1" },
    verifiedAt: NOW_S - 86400,
    expiresAt: NOW_S + 300 * 86400,
    ...over,
  };
}

test("a badge shows only while unrevoked, unlapsed, and with no upheld report", async () => {
  const k = "ebay:honest_boots";
  const none = new Map<string, number>();
  assert.ok(badgeFor(k, { [k]: { current: badge(), history: [] } }, none, NOW_S));
  assert.equal(badgeFor(k, { [k]: { current: badge({ revoked: { at: NOW_S, reason: "x" } }), history: [] } }, none, NOW_S), null);
  assert.equal(badgeFor(k, { [k]: { current: badge({ expiresAt: NOW_S }), history: [] } }, none, NOW_S), null);
  // Even if revocation never reached the chain, an upheld report hides it.
  assert.equal(badgeFor(k, { [k]: { current: badge(), history: [] } }, new Map([[k, 1]]), NOW_S), null);
  assert.equal(badgeFor("ebay:someone_else", { [k]: { current: badge(), history: [] } }, none, NOW_S), null);
});

test("a revoked badge is kept in history when the seller verifies again", async () => {
  const log = new VerifiedSellerLog(join(mkdtempSync(join(tmpdir(), "sigpath-sellers-")), "verified.json"));
  await log.record("ebay:x", badge());
  await assert.rejects(log.record("ebay:x", badge()), /already holds/);
  await log.markRevoked("ebay:x", { at: NOW_S, reason: "upheld" });
  await log.record("ebay:x", badge({ attestation: "A2" }));
  const e = await log.get("ebay:x");
  assert.equal(e?.current.attestation, "A2");
  assert.equal(e?.history.length, 1);
  assert.equal(e?.history[0].revoked?.reason, "upheld");
});

test("a revocation whose burn failed can be retried; a completed one can't be repeated", async () => {
  const log = new VerifiedSellerLog(join(mkdtempSync(join(tmpdir(), "sigpath-sellers-")), "verified.json"));
  await log.record("ebay:x", badge());
  await log.markRevoked("ebay:x", { at: NOW_S, reason: "upheld", chainError: "rpc down" });
  await log.markRevoked("ebay:x", { at: NOW_S + 60, reason: "upheld", signature: "Sig" });
  await assert.rejects(log.markRevoked("ebay:x", { at: NOW_S + 120, reason: "again" }), /already been revoked/);
});

// --- plumbing ---------------------------------------------------------------------------

test("the demo listing format stands in for a marketplace answer", () => {
  assert.deepEqual(stubListingForProof("my_shop:Genuine boots SIGPATH-ABCD-EFGH"), { ok: true, handle: "my_shop", text: "Genuine boots SIGPATH-ABCD-EFGH" });
  assert.equal(stubListingForProof("no colon here").ok, false);
});

test("Etsy handles contain a colon; the subject still hashes the whole handle", async () => {
  assert.deepEqual(await sellerSubject("etsy:shop:12345"), await subjectHash("etsy", "shop:12345"));
});

test("one badge address per handle, distinct from every report address", () => {
  const s = Buffer.alloc(32, 9);
  assert.equal(verifiedNonce(s), verifiedNonce(s));
  assert.notEqual(verifiedNonce(s), verifiedNonce(Buffer.alloc(32, 8)));
  assert.notEqual(verifiedNonce(s), reportNonce(s, 0));
});

test("the mint is funded for the 378 bytes SAS allocates plus the metadata and group-member extensions", () => {
  const a = "B3b7SgvPCwP7E33oMxmSTtcJhuJX1fwA1hnNjg7W4ShG";
  const space = mintAccountSpace("SigPath Verified Seller", "SPVS", "https://x.example/seller/ebay/h", a, a);
  // 378 + metadata(4+32+32 + 4+23 + 4+4 + 4+31 + 4 + 4+11 + 4+44 + 4+6 + 4+44) + member(76)
  assert.equal(space, 378 + 263 + 76);
});
