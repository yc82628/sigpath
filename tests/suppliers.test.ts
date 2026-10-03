import { test } from "node:test";
import assert from "node:assert";
import { checkSupplier, namesMatch, nameTokens, type SupplierDeps } from "../lib/suppliers/check";
import { domainRegistration, _resetRdapCache, type DomainRegistration } from "../lib/suppliers/rdap";
import type { Business } from "../lib/sellers/business";
import type { BadgeEntry } from "../lib/sellers/verified-log";

const NOW = Date.UTC(2026, 9, 3, 12);
const NOW_S = Math.floor(NOW / 1000);
const DAY = 86400 * 1000;

// --- names ------------------------------------------------------------------------------

test("names: legal forms and accents don't matter; a different word does", () => {
  assert.deepStrictEqual(nameTokens("Müller & Söhne GmbH & Co. KG"), ["muller", "sohne"]);
  assert.ok(namesMatch("Acme Trading", "ACME TRADING GMBH"));
  assert.ok(namesMatch("Google Ireland Ltd", "GOOGLE IRELAND LIMITED"));
  assert.ok(!namesMatch("Acme Tradng", "ACME TRADING GMBH"), "near-miss spellings are exactly what impersonators use");
  assert.ok(!namesMatch("Acme Global Trading", "ACME TRADING GMBH"));
  assert.ok(!namesMatch("GmbH", "ACME TRADING GMBH"), "nothing distinctive given");
});

// --- the registry lookup ------------------------------------------------------------------

function rdapFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (url: string) => {
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) return new Response("{}", { status: 599 });
    return new Response(JSON.stringify(hit[1].body ?? {}), { status: hit[1].status });
  }) as unknown as typeof fetch;
}
const BOOTSTRAP = { "https://data.iana.org/rdap/dns.json": { status: 200, body: { services: [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]]] } } };

test("rdap: asks the TLD's own registry, so 'not found' means not registered", async () => {
  _resetRdapCache();
  const f = rdapFetch({
    ...BOOTSTRAP,
    "https://rdap.verisign.com/com/v1/domain/old-shop.com": { status: 200, body: { events: [{ eventAction: "registration", eventDate: "2015-04-01T00:00:00Z" }] } },
    "https://rdap.verisign.com/com/v1/domain/fake-shop.com": { status: 404 },
    "https://rdap.denic.de/domain/beispiel.de": { status: 200, body: { events: [{ eventAction: "last changed", eventDate: "2024-01-01T00:00:00Z" }] } },
  });
  assert.deepStrictEqual(await domainRegistration("old-shop.com", f, NOW), { status: "registered", registeredAt: Date.parse("2015-04-01T00:00:00Z"), registry: "rdap.verisign.com" });
  assert.deepStrictEqual(await domainRegistration("fake-shop.com", f, NOW), { status: "not_registered", registry: "rdap.verisign.com" });
  assert.deepStrictEqual(await domainRegistration("beispiel.de", f, NOW), { status: "registered", registeredAt: null, registry: "rdap.denic.de" }, "DENIC publishes no date");
  const unsupported = await domainRegistration("shop.zz", f, NOW);
  assert.strictEqual(unsupported.status, "unknown");
});

// --- the report ---------------------------------------------------------------------------------

function vies(valid: boolean, name = "---"): typeof fetch {
  return (async () => new Response(JSON.stringify({ valid, name }), { status: 200 })) as unknown as typeof fetch;
}
const badge = (wallet: string): BadgeEntry => ({
  current: { wallet, attestation: "A", mint: "M", tokenAccount: "T", proof: { source: "ebay", listingId: "1" }, verifiedAt: NOW_S - 86400, expiresAt: NOW_S + 200 * 86400 },
  history: [],
});
function deps(over: Partial<SupplierDeps> & { reg?: DomainRegistration; businessesFor?: Record<string, Business>; badgesFor?: Record<string, BadgeEntry>; upheldFor?: Map<string, number> } = {}): SupplierDeps {
  return {
    fetchImpl: vies(true, "ACME TRADING GMBH"),
    businesses: async () => over.businessesFor ?? {},
    badges: async () => over.badgesFor ?? {},
    upheld: async () => over.upheldFor ?? new Map(),
    registration: async () => over.reg ?? { status: "registered", registeredAt: NOW - 6 * 365 * DAY, registry: "rdap.example" },
    now: () => NOW,
    ...over,
  };
}
function states(r: Awaited<ReturnType<typeof checkSupplier>>): Record<string, string> {
  if (!r.ok) throw new Error(r.error);
  return Object.fromEntries(r.report.findings.map((f) => [f.check + ":" + f.title, f.state]));
}

test("report: a consistent supplier with an old website is clear, never 'safe'", async () => {
  const r = await checkSupplier({ vatCountry: "DE", vatNumber: "DE 123456789", name: "Acme Trading", domain: "acme-trading.de" }, deps());
  assert.ok(r.ok);
  assert.strictEqual(r.report.summary.state, "clear");
  assert.ok(!/safe/i.test(r.report.summary.headline));
  assert.deepStrictEqual(states(r), {
    "vat:Registered business": "good",
    "name:Name matches the register": "good",
    "website:Established website": "good",
    "sigpath:Not a verified business on SigPath": "unknown",
  });
});

test("report: an invalid VAT number or a missing website is a concern", async () => {
  const bad = await checkSupplier({ vatCountry: "DE", vatNumber: "123", domain: "nope.de" }, deps({ fetchImpl: vies(false), reg: { status: "not_registered", registry: "rdap.denic.de" } }));
  assert.ok(bad.ok);
  assert.strictEqual(bad.report.summary.state, "concerns");
  assert.strictEqual(states(bad)["vat:VAT number not registered"], "bad");
  assert.strictEqual(states(bad)["website:Website domain doesn't exist"], "bad");
});

test("report: a borrowed VAT number (name mismatch) and a weeks-old website are warnings", async () => {
  const r = await checkSupplier(
    { vatCountry: "IE", vatNumber: "6388047V", name: "Cheap Phones Direct", domain: "cheap-phones-direct.com" },
    deps({ fetchImpl: vies(true, "GOOGLE IRELAND LIMITED"), reg: { status: "registered", registeredAt: NOW - 12 * DAY, registry: "rdap.verisign.com" } }),
  );
  assert.ok(r.ok);
  assert.strictEqual(r.report.summary.state, "warnings");
  assert.match(r.report.findings.find((f) => f.check === "name")!.detail, /GOOGLE IRELAND LIMITED/);
  assert.match(r.report.findings.find((f) => f.check === "website")!.detail, /12 days ago/);
});

test("report: names the register doesn't publish, and registries without dates, are 'unknown', not warnings", async () => {
  const r = await checkSupplier(
    { vatCountry: "DE", vatNumber: "123456789", name: "Beispiel GmbH", domain: "beispiel.de" },
    deps({ fetchImpl: vies(true, "---"), reg: { status: "registered", registeredAt: null, registry: "rdap.denic.de" } }),
  );
  assert.ok(r.ok);
  assert.strictEqual(states(r)["name:Name not confirmed"], "unknown");
  assert.strictEqual(states(r)["website:Website exists, age unknown"], "unknown");
  assert.strictEqual(r.report.summary.state, "clear");
});

test("report: SigPath's records — verified business, upheld reports, and borrowed identities", async () => {
  const w = "Wallet1";
  const business: Business = {
    id: "b_acme", wallet: w, createdAt: NOW_S,
    vat: { country: "DE", number: "123456789", registeredName: null, checkedAt: NOW_S - 86400 },
    domain: { name: "acme-trading.de", verifiedAt: NOW_S },
  };
  const base = { businessesFor: { [w]: business }, badgesFor: { "ebay:acme_shop": badge(w), "ebay:copycat": badge("Other") } };

  const verified = await checkSupplier({ marketplace: "ebay", handle: "acme_shop" }, deps(base));
  assert.ok(verified.ok);
  assert.strictEqual(verified.report.summary.state, "verified");
  assert.strictEqual(verified.report.businessProfile, "/business/b_acme");

  // A scammer quoting a real verified business's VAT number with their own website.
  const borrowed = await checkSupplier({ vatCountry: "DE", vatNumber: "123456789", domain: "acme-trading-outlet.com" }, deps(base));
  assert.ok(borrowed.ok);
  assert.strictEqual(borrowed.report.summary.state, "concerns");
  assert.match(borrowed.report.findings.find((f) => f.title === "Details belong to a different business")!.detail, /website/);

  const reported = await checkSupplier({ marketplace: "ebay", handle: "copycat" }, deps({ ...base, upheldFor: new Map([["ebay:copycat", 2]]) }));
  assert.ok(reported.ok);
  assert.strictEqual(states(reported)["sigpath:Upheld fake-product reports"], "bad");
});

test("report: input is validated, and at least one detail is needed", async () => {
  const d = deps();
  assert.deepStrictEqual(await checkSupplier({ name: "Acme" }, d), { ok: false, error: "Enter at least a VAT number, a website or a marketplace account." });
  assert.ok(!(await checkSupplier({ vatCountry: "US", vatNumber: "123" }, d)).ok);
  assert.ok(!(await checkSupplier({ domain: "not a domain" }, d)).ok);
  assert.ok(!(await checkSupplier({ handle: "x", marketplace: "aliexpress" }, d)).ok);
  const nameOnly = await checkSupplier({ name: "Acme", domain: "acme-trading.de" }, d);
  assert.ok(nameOnly.ok);
  assert.strictEqual(states(nameOnly)["name:Name not checked"], "unknown", "a name needs a VAT number to check against");
});
