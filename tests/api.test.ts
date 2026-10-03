import { test } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";
import { businessRecord, sellerRecord, SELLER_MEANING, type ApiDeps } from "../lib/api/verification";
import { refuseUnpaid } from "../lib/api/gate";
import { GATEWAY_HEADER } from "../lib/agents/check";
import type { Business } from "../lib/sellers/business";
import type { BadgeEntry } from "../lib/sellers/verified-log";
import type { PublicFinding } from "../lib/reports/seller";
import type { OnChainBadge } from "../lib/chains/solana/sas-verified";

const NOW = Date.UTC(2026, 9, 3, 12);
const NOW_S = Math.floor(NOW / 1000);
const W = "WalletAcme";

const badge = (wallet: string): BadgeEntry => ({
  current: { wallet, attestation: "AttAcme", mint: "M", tokenAccount: "T", proof: { source: "ebay", listingId: "1" }, verifiedAt: NOW_S - 30 * 86400, expiresAt: NOW_S + 300 * 86400 },
  history: [],
});
const ACME: Business = {
  id: "b_acme", wallet: W, createdAt: NOW_S,
  vat: { country: "DE", number: "123456789", registeredName: null, checkedAt: NOW_S - 86400 },
  domain: { name: "acme-shop.de", verifiedAt: NOW_S - 3600 },
};

function deps(over: Partial<ApiDeps> & { upheldFor?: Map<string, number>; chain?: OnChainBadge | null; findingsFor?: PublicFinding[] } = {}): ApiDeps {
  return {
    badges: async () => ({ "ebay:acme_shop": badge(W), "etsy:acme_shop": badge(W) }),
    businesses: async () => ({ [W]: ACME }),
    upheld: async () => over.upheldFor ?? new Map(),
    findings: async () => over.findingsFor ?? [],
    onChain: async () => (over.chain === undefined ? { status: "valid", attestation: "AttAcme", mint: "M", holder: W, verifiedAt: NOW_S, expiresAt: NOW_S + 1 } : over.chain),
    baseUrl: "https://sigpath.example",
    now: () => NOW,
    ...over,
  };
}

test("seller: a verified seller confirmed on Solana, with the business behind it", async () => {
  const r = await sellerRecord({ marketplace: "eBay", handle: " acme_shop " }, deps());
  assert.ok(r.ok);
  assert.strictEqual(r.value.marketplace, "ebay");
  assert.deepStrictEqual(r.value.verifiedSeller, { since: new Date((NOW_S - 30 * 86400) * 1000).toISOString(), expires: new Date((NOW_S + 300 * 86400) * 1000).toISOString(), attestation: "AttAcme", onChain: "valid" });
  assert.deepStrictEqual(r.value.verifiedBusiness, { name: null, country: "Germany", domain: "acme-shop.de", profile: "https://sigpath.example/business/b_acme" });
  assert.strictEqual(r.value.upheldReports, 0);
  assert.strictEqual(r.value.meaning, SELLER_MEANING);
});

test("seller: the badge is hidden when Solana disagrees, and 'not_checked' without a chain", async () => {
  const notHeld = await sellerRecord({ marketplace: "ebay", handle: "acme_shop" }, deps({ chain: { status: "not_held", attestation: "AttAcme", holder: null, expiresAt: NOW_S + 1 } }));
  assert.ok(notHeld.ok);
  assert.strictEqual(notHeld.value.verifiedSeller, null);
  assert.strictEqual(notHeld.value.verifiedBusiness, null, "no confirmed badge, no business");
  const noChain = await sellerRecord({ marketplace: "ebay", handle: "acme_shop" }, deps({ chain: null }));
  assert.ok(noChain.ok);
  assert.strictEqual(noChain.value.verifiedSeller?.onChain, "not_checked");
});

test("seller: upheld reports hide the badge and come back as findings, with the seller's reply noted", async () => {
  const finding: PublicFinding = { status: "upheld", category: "counterfeit", decidedAt: NOW_S - 86400, attestation: "AttFinding", reply: { at: NOW_S - 2 * 86400, text: "we disagree" } };
  const r = await sellerRecord({ marketplace: "ebay", handle: "acme_shop" }, deps({ upheldFor: new Map([["ebay:acme_shop", 1]]), findingsFor: [finding] }));
  assert.ok(r.ok);
  assert.strictEqual(r.value.verifiedSeller, null);
  assert.strictEqual(r.value.upheldReports, 1);
  assert.deepStrictEqual(r.value.findings, [{ category: "counterfeit", status: "upheld", decidedAt: new Date((NOW_S - 86400) * 1000).toISOString(), reversedAt: null, attestation: "AttFinding", sellerReplied: true }]);
});

test("seller: unknown accounts are a plain 'no record', and bad input is refused", async () => {
  const r = await sellerRecord({ marketplace: "etsy", handle: "someone_else" }, deps());
  assert.ok(r.ok);
  assert.deepStrictEqual([r.value.verifiedSeller, r.value.verifiedBusiness, r.value.upheldReports, r.value.findings], [null, null, 0, []]);
  assert.deepStrictEqual((await sellerRecord({ marketplace: "aliexpress", handle: "x" }, deps())).ok, false);
  assert.deepStrictEqual((await sellerRecord({ marketplace: "ebay", handle: "" }, deps())).ok, false);
});

test("business: found by VAT number, website or id, with its evidence and accounts", async () => {
  for (const q of [{ vatCountry: "de", vatNumber: "DE 123 456 789" }, { domain: "https://www.acme-shop.de/" }, { id: "b_acme" }]) {
    const r = await businessRecord(q, deps());
    assert.ok(r.ok, JSON.stringify(q));
    assert.strictEqual(r.value.found, true);
    assert.strictEqual(r.value.status, "verified");
    assert.strictEqual(r.value.country, "Germany");
    assert.strictEqual(r.value.vat?.masked, "DE•••••6789", "the full number is never returned");
    assert.strictEqual(r.value.website?.domain, "acme-shop.de");
    assert.strictEqual(r.value.accounts.length, 2);
    assert.strictEqual(r.value.profile, "https://sigpath.example/business/b_acme");
  }
});

test("business: not found is found:false, not an error; bad keys are refused", async () => {
  const r = await businessRecord({ domain: "unknown-shop.de" }, deps());
  assert.ok(r.ok);
  assert.strictEqual(r.value.found, false);
  assert.ok(!(await businessRecord({}, deps())).ok);
  assert.ok(!(await businessRecord({ vatCountry: "US", vatNumber: "1" }, deps())).ok);
  assert.ok(!(await businessRecord({ domain: "not a domain" }, deps())).ok);
});

test("gate: with a gateway key set, only forwarded (paid) requests get through", () => {
  const before = process.env.SIGPATH_GATEWAY_KEY;
  try {
    delete process.env.SIGPATH_GATEWAY_KEY;
    assert.strictEqual(refuseUnpaid(new NextRequest("http://x/api/v1/seller")), null, "open without a key (dev, sandbox)");
    process.env.SIGPATH_GATEWAY_KEY = "k".repeat(40);
    assert.strictEqual(refuseUnpaid(new NextRequest("http://x/api/v1/seller"))?.status, 401);
    assert.strictEqual(refuseUnpaid(new NextRequest("http://x/api/v1/seller", { headers: { [GATEWAY_HEADER]: "wrong" } }))?.status, 401);
    assert.strictEqual(refuseUnpaid(new NextRequest("http://x/api/v1/seller", { headers: { [GATEWAY_HEADER]: "k".repeat(40) } })), null);
  } finally {
    if (before === undefined) delete process.env.SIGPATH_GATEWAY_KEY;
    else process.env.SIGPATH_GATEWAY_KEY = before;
  }
});
