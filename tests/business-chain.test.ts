import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { businessNonce, domainHash, vatHash, BUSINESS_SCHEMA_FIELDS, BUSINESS_SCHEMA_LAYOUT } from "../lib/chains/solana/sas-business";
import { BusinessLog, businessMessage, type Business } from "../lib/sellers/business";
import { submitVat, vatAction, type BusinessDeps } from "../lib/sellers/business-api";
import { businessRevoker } from "../lib/sellers/business-chain";
import { VerifiedSellerLog, type BadgeEntry } from "../lib/sellers/verified-log";
import { businessRecord, type ApiDeps } from "../lib/api/verification";

const NOW = Date.UTC(2026, 9, 3, 12);
const NOW_S = Math.floor(NOW / 1000);

test("on chain: hashes are purpose-separated, case-insensitive, and hide the details", () => {
  assert.strictEqual(vatHash("de", "123456789"), vatHash("DE", "123456789"));
  assert.notStrictEqual(vatHash("DE", "123456789"), vatHash("AT", "123456789"));
  assert.match(vatHash("DE", "123456789"), /^[0-9a-f]{64}$/);
  assert.ok(!vatHash("DE", "123456789").includes("123456789"));
  assert.strictEqual(domainHash("Example-Shop.de"), domainHash("example-shop.de"));
  assert.notStrictEqual(domainHash("example.de"), vatHash("EX", "AMPLE.DE"), "a domain can't pass for a VAT number");
  assert.strictEqual(BUSINESS_SCHEMA_FIELDS.length, BUSINESS_SCHEMA_LAYOUT.length);
});

test("on chain: the attestation nonce comes from the wallet alone, and differs per wallet", () => {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  assert.strictEqual(businessNonce(a), businessNonce(a));
  assert.notStrictEqual(businessNonce(a), businessNonce(b));
  assert.throws(() => businessNonce("not-a-wallet"));
});

// --- publishing as part of the business steps ---------------------------------------------

function setup(publish?: BusinessDeps["publish"]) {
  const dir = mkdtempSync(join(tmpdir(), "bizchain-"));
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const badges: Record<string, BadgeEntry> = {
    "ebay:shop": { current: { wallet, attestation: "A", mint: "M", tokenAccount: "T", proof: { source: "ebay", listingId: "1" }, verifiedAt: NOW_S - 86400, expiresAt: NOW_S + 300 * 86400 }, history: [] },
  };
  const log = new BusinessLog(join(dir, "b.json"));
  const deps: BusinessDeps = {
    log,
    badges: async () => badges,
    upheld: async () => new Map(),
    fetchImpl: (async () => new Response(JSON.stringify({ valid: true, name: "ACME GMBH" }), { status: 200 })) as unknown as typeof fetch,
    resolveTxt: async () => [],
    env: { QUOTE_SECRET: "q".repeat(40) },
    now: () => NOW,
    publish,
  };
  const time = new Date(NOW).toISOString();
  const sign = (action: string) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(businessMessage(action, wallet, time)), kp.secretKey)).toString("base64");
  const vat = () => submitVat({ wallet, time, signature: sign(vatAction("DE", "123456789")), country: "DE", vatNumber: "123456789" }, deps);
  return { dir, wallet, log, badges, vat, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("publish: a newly verified business is recorded on chain, and the record says where", async () => {
  const calls: { b: Business; accounts: number }[] = [];
  const t = setup(async (b, v) => {
    calls.push({ b, accounts: v.accounts.length });
    return { attestation: "AttBiz111", signature: "Sig111", publishedAt: NOW_S };
  });
  try {
    const r = await t.vat();
    assert.ok(r.ok);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].b.vat?.number, "123456789");
    assert.deepStrictEqual(r.value.onChain, { attestation: "AttBiz111", signature: "Sig111", publishedAt: NOW_S });
    assert.strictEqual((await t.log.byWallet(t.wallet))?.onChain?.attestation, "AttBiz111");
  } finally {
    t.cleanup();
  }
});

test("publish: a chain failure is recorded, and the business is still verified", async () => {
  const t = setup(async () => {
    throw new Error("RPC unavailable");
  });
  try {
    const r = await t.vat();
    assert.ok(r.ok, "verification doesn't depend on the chain");
    assert.strictEqual(r.value.status, "verified");
    assert.match(r.value.onChain?.error ?? "", /RPC unavailable/);
  } finally {
    t.cleanup();
  }
});

test("publish: nothing is published when the business isn't verified, or without a chain", async () => {
  let called = 0;
  const t = setup(async () => {
    called++;
    return { attestation: "x", publishedAt: NOW_S };
  });
  try {
    delete t.badges["ebay:shop"]; // no verified account: not eligible at all
    assert.ok(!(await t.vat()).ok);
    assert.strictEqual(called, 0);
  } finally {
    t.cleanup();
  }
  const off = setup(undefined);
  try {
    const r = await off.vat();
    assert.ok(r.ok);
    assert.strictEqual(r.value.onChain, null, "off-chain only");
  } finally {
    off.cleanup();
  }
});

test("revoke: an upheld report closes the attestation of the business holding that seller's badge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bizrevoke-"));
  try {
    const badgeLog = new VerifiedSellerLog(join(dir, "verified.json"));
    const log = new BusinessLog(join(dir, "b.json"));
    await badgeLog.record("ebay:shop", { wallet: "W1", attestation: "A", mint: "M", tokenAccount: "T", proof: { source: "ebay", listingId: "1" }, verifiedAt: NOW_S, expiresAt: NOW_S + 1000 });
    // No business on chain for this wallet yet: nothing to close.
    assert.strictEqual(await businessRevoker(log, badgeLog, null)("ebay:shop"), null);
    await log.update("W1", (b) => ({ ...b, onChain: { attestation: "AttBiz", publishedAt: NOW_S } }));
    // A recorded business but no chain configured: says so, changes nothing.
    assert.deepStrictEqual(await businessRevoker(log, badgeLog, null)("ebay:shop"), { wallet: "W1", chainError: "No chain configured." });
    assert.strictEqual((await log.byWallet("W1"))?.onChain?.revokedAt, undefined);
    assert.strictEqual(await businessRevoker(log, badgeLog, null)("etsy:nobody"), null, "an unknown seller");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("api: the business answer carries its wallet and the chain's view, read live", async () => {
  const w = "WalletChain";
  const deps: ApiDeps = {
    badges: async () => ({ "ebay:s": { current: { wallet: w, attestation: "A", mint: "M", tokenAccount: "T", proof: { source: "ebay", listingId: "1" }, verifiedAt: NOW_S - 10, expiresAt: NOW_S + 1000 }, history: [] } }),
    businesses: async () => ({ [w]: { id: "b_c", wallet: w, createdAt: NOW_S, vat: { country: "DE", number: "123456789", registeredName: null, checkedAt: NOW_S - 10 } } }),
    upheld: async () => new Map(),
    findings: async () => [],
    onChain: async () => null,
    onChainBusiness: async () => ({ status: "valid", attestation: "AttBizLive", country: "DE", vatHash: vatHash("DE", "123456789"), domainHash: null, linkedAccounts: 1, verifiedAt: NOW_S, expiresAt: NOW_S + 1000 }),
    baseUrl: "https://sigpath.example",
    now: () => NOW,
  };
  const r = await businessRecord({ id: "b_c" }, deps);
  assert.ok(r.ok);
  assert.strictEqual(r.value.wallet, w);
  assert.deepStrictEqual(r.value.onChain, { status: "valid", attestation: "AttBizLive" });
  const off = await businessRecord({ id: "b_c" }, { ...deps, onChainBusiness: undefined });
  assert.ok(off.ok);
  assert.deepStrictEqual(off.value.onChain, { status: "not_checked", attestation: null });
});
