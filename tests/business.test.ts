import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  BusinessLog,
  businessIndex,
  businessMessage,
  businessView,
  checkVat,
  domainHasRecord,
  domainRecord,
  maskVat,
  normaliseDomain,
  normaliseVat,
  verifiedPhotoFlags,
  verifyBusinessSignature,
  BUSINESS_TTL_SECS,
  type Business,
} from "../lib/sellers/business";
import { domainAction, submitVat, vatAction, verifyDomain, startDomain, businessStatus, type BusinessDeps } from "../lib/sellers/business-api";
import type { BadgeEntry } from "../lib/sellers/verified-log";
import { businessLine, checkLabel } from "../lib/marketplace/label";
import { analyse } from "../lib/marketplace/anomaly";
import { priceCheckFor } from "../lib/checkout/eligibility";
import type { Listing } from "../lib/marketplace/types";

const NOW = Date.UTC(2026, 9, 3, 12);
const NOW_S = Math.floor(NOW / 1000);
const ENV = { QUOTE_SECRET: "q".repeat(40) };

// --- VAT -------------------------------------------------------------------------------

test("vat: normalises the number and the country", () => {
  assert.deepStrictEqual(normaliseVat("de", "DE 123.456-789"), { country: "DE", number: "123456789" });
  assert.deepStrictEqual(normaliseVat("GR", "EL094259216"), { country: "EL", number: "094259216" }, "Greece is EL in VIES");
  assert.strictEqual(normaliseVat("US", "123456789"), null, "only countries the register answers for");
  assert.strictEqual(normaliseVat("DE", "1"), null);
  assert.strictEqual(maskVat("DE", "123456789"), "DE•••••6789");
});

function viesFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

test("vat: reads the register's answer, including names a country doesn't publish", async () => {
  assert.deepStrictEqual(await checkVat("IE", "6388047V", viesFetch(200, { valid: true, name: "GOOGLE IRELAND LIMITED" })), { status: "valid", registeredName: "GOOGLE IRELAND LIMITED" });
  assert.deepStrictEqual(await checkVat("DE", "123456789", viesFetch(200, { valid: true, name: "---" })), { status: "valid", registeredName: null });
  assert.deepStrictEqual(await checkVat("DE", "123456789", viesFetch(200, { valid: false, name: "---" })), { status: "invalid" });
  const down = await checkVat("DE", "1", viesFetch(200, { actionSucceed: false, errorWrappers: [{ error: "MS_UNAVAILABLE" }] }));
  assert.deepStrictEqual(down, { status: "unavailable", detail: "MS_UNAVAILABLE" });
  const offline = await checkVat("DE", "1", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
  assert.strictEqual(offline.status, "unavailable");
});

// --- website ---------------------------------------------------------------------------

test("domain: normalises what people paste, refuses what isn't a domain", () => {
  assert.strictEqual(normaliseDomain("https://www.Example-Shop.de/about?x=1"), "example-shop.de");
  assert.strictEqual(normaliseDomain("shop.example.co.uk."), "shop.example.co.uk");
  assert.strictEqual(normaliseDomain("me@example.com"), null);
  assert.strictEqual(normaliseDomain("localhost"), null);
  assert.strictEqual(normaliseDomain("example.com:8080"), null);
});

test("domain: the record is bound to the wallet and the domain, and found across TXT chunks", async () => {
  const r = domainRecord("WalletA", "example.de", ENV)!;
  assert.strictEqual(r.name, "_sigpath.example.de");
  assert.match(r.value, /^sigpath-verify=[A-Za-z0-9_-]{24}$/);
  assert.notStrictEqual(domainRecord("WalletB", "example.de", ENV)!.value, r.value);
  assert.notStrictEqual(domainRecord("WalletA", "other.de", ENV)!.value, r.value);
  assert.strictEqual(domainRecord("WalletA", "example.de", {}), null, "no secret, no records");
  const split = [r.value.slice(0, 10), r.value.slice(10)];
  assert.ok(await domainHasRecord(r, async (name) => (name === r.name ? [["v=spf1 -all"], split] : [])));
  assert.ok(!(await domainHasRecord(r, async () => [["sigpath-verify=wrong"]])));
  assert.ok(!(await domainHasRecord(r, async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); })));
});

// --- signatures --------------------------------------------------------------------------

function signer() {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const sign = (action: string, time = new Date(NOW).toISOString()) => ({
    wallet,
    time,
    signature: Buffer.from(nacl.sign.detached(new TextEncoder().encode(businessMessage(action, wallet, time)), kp.secretKey)).toString("base64"),
  });
  return { wallet, sign };
}

test("signature: only the wallet, only for that action, only while fresh", () => {
  const { wallet, sign } = signer();
  const s = sign("check VAT number DE123456789");
  assert.deepStrictEqual(verifyBusinessSignature("check VAT number DE123456789", wallet, s.time, s.signature, NOW), { ok: true });
  assert.strictEqual(verifyBusinessSignature("check VAT number DE999999999", wallet, s.time, s.signature, NOW).ok, false, "a different action");
  assert.strictEqual(verifyBusinessSignature("check VAT number DE123456789", wallet, s.time, s.signature, NOW + 11 * 60_000).ok, false, "stale");
  const other = signer();
  assert.strictEqual(verifyBusinessSignature("check VAT number DE123456789", other.wallet, s.time, s.signature, NOW).ok, false, "another wallet");
  assert.strictEqual(verifyBusinessSignature("x", "not-a-wallet", s.time, s.signature, NOW).ok, false);
});

// --- what a business is ----------------------------------------------------------------------

function badge(wallet: string, over: Partial<BadgeEntry["current"]> = {}): BadgeEntry {
  return {
    current: { wallet, attestation: "Att" + wallet.slice(0, 6), mint: "M", tokenAccount: "T", proof: { source: "stub", listingId: "1" }, verifiedAt: NOW_S - 86400, expiresAt: NOW_S + 300 * 86400, ...over },
    history: [],
  };
}
const biz = (wallet: string, over: Partial<Business> = {}): Business => ({
  id: "b_test",
  wallet,
  createdAt: NOW_S,
  vat: { country: "IE", number: "6388047V", registeredName: "GOOGLE IRELAND LIMITED", checkedAt: NOW_S - 86400 },
  ...over,
});

test("business: verified, incomplete, suspended and expired, each with the reason", () => {
  const w = "Wallet1111";
  const badges = { "ebay:shop_one": badge(w), "etsy:shop_one": badge(w), "ebay:stranger": badge("OtherWallet") };
  const none = new Map<string, number>();
  const v = businessView(biz(w), badges, none, NOW_S);
  assert.strictEqual(v.status, "verified");
  assert.deepStrictEqual(v.accounts.map((a) => a.sellerKey).sort(), ["ebay:shop_one", "etsy:shop_one"], "linked by wallet, nothing else");
  assert.strictEqual(v.vatMasked, "IE••••047V");

  assert.strictEqual(businessView(biz(w, { vat: undefined }), badges, none, NOW_S).status, "incomplete");
  assert.strictEqual(businessView(biz(w), { "ebay:shop_one": badge(w, { revoked: { at: NOW_S, reason: "x" } }) }, none, NOW_S).status, "incomplete");
  const suspended = businessView(biz(w), badges, new Map([["etsy:shop_one", 1]]), NOW_S);
  assert.strictEqual(suspended.status, "suspended", "one upheld report on any linked account");
  assert.match(suspended.statusReason!, /upheld/);
  assert.strictEqual(businessView(biz(w), badges, none, NOW_S - 86400 + BUSINESS_TTL_SECS).status, "expired");
});

test("business index: only active accounts of verified businesses", () => {
  const w = "Wallet2222";
  const badges = { "ebay:a": badge(w), "etsy:a": badge(w, { revoked: { at: NOW_S, reason: "x" } }) };
  const all = { [w]: biz(w, { domain: { name: "example.ie", verifiedAt: NOW_S } }), Other: biz("Other", { id: "b_other", vat: undefined }) };
  const index = businessIndex(all, badges, new Map(), NOW_S);
  assert.deepStrictEqual([...index.keys()], ["ebay:a"]);
  assert.deepStrictEqual(index.get("ebay:a"), { id: "b_test", name: "GOOGLE IRELAND LIMITED", country: "Ireland", domain: "example.ie" });
});

test("photo theft: a verified business's photo under an unlinked account on another marketplace", () => {
  const index = new Map([["ebay:real_shop", { id: "b1", name: "Real Shop GmbH", country: "Germany" }], ["etsy:real_shop", { id: "b1", name: "Real Shop GmbH", country: "Germany" }]]);
  const l = (source: string, handle: string, id: string, imageHash = "img-1"): Listing => ({
    id, source: source as Listing["source"], title: "x", url: "https://x.invalid", price: { amount: 100, currency: "EUR" }, condition: "new", imageHash, seller: { handle },
  });
  const flags = verifiedPhotoFlags([l("ebay", "real_shop", "1"), l("etsy", "real_shop", "2"), l("etsy", "copycat", "3"), l("ebay", "copycat2", "4"), l("etsy", "other", "5", "img-2")], index);
  assert.deepStrictEqual(flags.map((f) => `${f.source}:${f.listingId}`), ["etsy:3"], "linked accounts and same-marketplace reuse are not flagged here");
  assert.match(flags[0].message, /verified business on another marketplace/);
});

test("label: the business line replaces the seller line and upgrades no verdict", () => {
  const b = { id: "b1", name: null, country: "Germany", domain: "example.de" };
  assert.strictEqual(businessLine(b), "Verified business: VAT number registered in Germany (the register doesn't publish the name), owns example.de. That vouches for who runs the account, not this price.");
  const bait: Listing = { id: "x", source: "stub", title: "t", url: "https://x.invalid", price: { amount: 100, currency: "EUR" }, condition: "new", seller: { handle: "h" } };
  const a = analyse([{ source: "stub", status: "ok", listings: [bait] }]);
  const label = checkLabel(bait, [], priceCheckFor(bait, a), a, false, NOW, b);
  assert.strictEqual(label.verdict, "unchecked", "a business can't make an unchecked price checked");
  assert.ok(label.points.some((p) => p.text.startsWith("Verified business")));
  assert.ok(!label.points.some((p) => p.text.startsWith("Verified seller")));
});

// --- the steps, end to end ----------------------------------------------------------------------

function deps(over: Partial<BusinessDeps> & { badgesFor?: Record<string, BadgeEntry>; upheldFor?: Map<string, number> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "biz-"));
  const d: BusinessDeps = {
    log: new BusinessLog(join(dir, "businesses.json")),
    badges: async () => over.badgesFor ?? {},
    upheld: async () => over.upheldFor ?? new Map(),
    fetchImpl: viesFetch(200, { valid: true, name: "GOOGLE IRELAND LIMITED" }),
    resolveTxt: async () => [],
    env: ENV,
    now: () => NOW,
    ...over,
  };
  return { d, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("steps: a verified seller attaches a VAT-checked business, then a website", async () => {
  const { wallet, sign } = signer();
  let txt: string[][] = [];
  const { d, cleanup } = deps({ badgesFor: { "ebay:shop": badge(wallet), "etsy:shop": badge(wallet) }, resolveTxt: async () => txt });
  try {
    const vat = await submitVat({ ...sign(vatAction("IE", "6388047V")), country: "ie", vatNumber: "IE 6388047V" }, d);
    assert.ok(vat.ok, JSON.stringify(vat));
    assert.strictEqual(vat.value.status, "verified");
    assert.strictEqual(vat.value.registeredName, "GOOGLE IRELAND LIMITED");
    assert.strictEqual(vat.value.accounts.length, 2);

    const start = await startDomain({ wallet, domain: "https://www.example.ie/" }, d);
    assert.ok(start.ok);
    const notYet = await verifyDomain({ ...sign(domainAction("example.ie")), domain: "example.ie" }, d);
    assert.deepStrictEqual([notYet.ok, !notYet.ok && notYet.status], [false, 422]);
    txt = [[start.value.record.value]];
    const done = await verifyDomain({ ...sign(domainAction("example.ie")), domain: "example.ie" }, d);
    assert.ok(done.ok);
    assert.strictEqual(done.value.domain, "example.ie");

    const status = await businessStatus(wallet, d);
    assert.strictEqual(status.business?.id, vat.value.id, "the same business, found again by wallet");
  } finally {
    cleanup();
  }
});

test("steps: refusals, each with its reason", async () => {
  const { wallet, sign } = signer();
  const step = (country = "IE", number = "6388047V") => ({ ...sign(vatAction(country, number)), country, vatNumber: number });

  let t = deps();
  const noBadge = await submitVat(step(), t.d);
  assert.deepStrictEqual([noBadge.ok, !noBadge.ok && noBadge.status], [false, 403]);
  t.cleanup();

  t = deps({ badgesFor: { "ebay:shop": badge(wallet) }, upheldFor: new Map([["ebay:shop", 1]]) });
  const penalised = await submitVat(step(), t.d);
  assert.ok(!penalised.ok && penalised.status === 403 && /upheld/.test(penalised.error));
  t.cleanup();

  t = deps({ badgesFor: { "ebay:shop": badge(wallet) }, fetchImpl: viesFetch(200, { valid: false }) });
  const invalid = await submitVat(step(), t.d);
  assert.ok(!invalid.ok && invalid.status === 422);
  t.cleanup();

  t = deps({ badgesFor: { "ebay:shop": badge(wallet) }, fetchImpl: viesFetch(500, {}) });
  const down = await submitVat(step(), t.d);
  assert.ok(!down.ok && down.status === 503);
  t.cleanup();

  t = deps({ badgesFor: { "ebay:shop": badge(wallet) } });
  const forged = await submitVat({ ...step(), vatNumber: "9999999X" }, t.d);
  assert.ok(!forged.ok && forged.status === 401, "signed for a different number");
  // The website may come before the VAT check; here the DNS record just isn't there yet.
  const beforeVat = await verifyDomain({ ...sign(domainAction("example.ie")), domain: "example.ie" }, t.d);
  assert.ok(!beforeVat.ok && beforeVat.status === 422, "website before VAT is allowed; missing record is 422");
  assert.ok(!(await submitVat({ ...step(), country: "US" }, t.d)).ok);
  t.cleanup();
});

test("steps: a website can be proved before the VAT number, but the business isn't verified without VAT", async () => {
  const { wallet, sign } = signer();
  let txt: string[][] = [];
  const { d, cleanup } = deps({ badgesFor: { "ebay:shop": badge(wallet) }, resolveTxt: async () => txt });
  try {
    const start = await startDomain({ wallet, domain: "example.ie" }, d);
    assert.ok(start.ok);
    txt = [[start.value.record.value]];
    const r = await verifyDomain({ ...sign(domainAction("example.ie")), domain: "example.ie" }, d);
    assert.ok(r.ok);
    assert.strictEqual(r.value.domain, "example.ie");
    assert.strictEqual(r.value.status, "incomplete");
    assert.match(r.value.statusReason!, /VAT/);
    // Without a verified badge, not even the website step.
    const stranger = signer();
    const refused = await verifyDomain({ ...stranger.sign(domainAction("example.ie")), domain: "example.ie" }, d);
    assert.ok(!refused.ok && refused.status === 403);
  } finally {
    cleanup();
  }
});
