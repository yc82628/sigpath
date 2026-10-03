/**
 * lib/api/verification.ts — SigPath's verification checks, as a paid API.
 *
 * Other apps (marketplaces, accounting and procurement tools, AI agents) ask
 * the same questions the website answers, in JSON:
 *
 *   seller    Is this marketplace account a verified seller, cross-checked on
 *             Solana? Which verified business runs it? Any upheld reports?
 *   business  Is this a verified business (by VAT number, website or id), on
 *             what evidence, and which accounts does it link?
 *   supplier  The full supplier check (lib/suppliers/check.ts).
 *
 * PAYING NEVER CHANGES AN ANSWER
 * These functions are the website's own logic over the same records, with no
 * knowledge of who is calling or whether they paid. A seller or business
 * cannot buy a better result, and an API customer gets exactly what a shopper
 * would see. Every answer carries `meaning`: what it vouches for, and what not.
 */

import { sellerKey } from "../marketplace/types";
import { badgeFor, type BadgeEntry } from "../sellers/verified-log";
import { businessIndex, businessView, normaliseDomain, normaliseVat, VIES_COUNTRIES, type Business } from "../sellers/business";
import type { PublicFinding } from "../reports/seller";
import type { OnChainBadge } from "../chains/solana/sas-verified";

export const API_MARKETPLACES = ["ebay", "etsy", "amazon"] as const;

export const SELLER_MEANING =
  "A verified seller proved control of this marketplace account, holds a non-transferable badge on Solana, and passed a live check. A verified business is also registered in the EU VAT register. Both vouch for who runs the account, not for any item. Findings are fake-product reports upheld after review, with the seller's reply.";
export const BUSINESS_MEANING =
  "A verified business has an EU VAT number valid in the VIES register, linked marketplace accounts each holding a verified-seller badge, and optionally a website it proved through DNS. It answers who runs these accounts, not whether an item is genuine. One upheld fake-product report on any linked account suspends it.";

const iso = (s: number) => new Date(s * 1000).toISOString();

export interface ApiDeps {
  badges: () => Promise<Record<string, BadgeEntry>>;
  businesses: () => Promise<Record<string, Business>>;
  upheld: () => Promise<ReadonlyMap<string, number>>;
  findings: (sellerKey: string) => Promise<PublicFinding[]>;
  /** The badge as Solana holds it; null when no chain is configured. */
  onChain: (sellerKey: string) => Promise<OnChainBadge | null>;
  baseUrl: string;
  now?: () => number;
}

export type ApiReply<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

// --- seller ------------------------------------------------------------------------------

export interface SellerRecord {
  marketplace: string;
  handle: string;
  verifiedSeller: {
    since: string;
    expires: string;
    attestation: string;
    /** "valid" when Solana agrees the badge is held; "not_checked" when no chain is configured. */
    onChain: OnChainBadge["status"] | "not_checked";
  } | null;
  verifiedBusiness: { name: string | null; country: string; domain: string | null; profile: string } | null;
  upheldReports: number;
  findings: { category: string; status: "upheld" | "reversed"; decidedAt: string; reversedAt: string | null; attestation: string | null; sellerReplied: boolean }[];
  checkedAt: string;
  meaning: string;
}

export async function sellerRecord(input: { marketplace: string; handle: string }, deps: ApiDeps): Promise<ApiReply<SellerRecord>> {
  const marketplace = input.marketplace.trim().toLowerCase();
  const handle = input.handle.trim();
  if (!(API_MARKETPLACES as readonly string[]).includes(marketplace)) return { ok: false, status: 400, error: `marketplace must be one of ${API_MARKETPLACES.join(", ")}.` };
  if (!handle || handle.length > 100) return { ok: false, status: 400, error: "Pass the seller's handle on that marketplace." };

  const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const key = sellerKey(marketplace, handle);
  const [badges, businesses, upheld, findings] = await Promise.all([deps.badges(), deps.businesses(), deps.upheld(), deps.findings(key)]);

  // Same rule as the seller page: shown only when SigPath's log AND the chain agree.
  const local = badgeFor(key, badges, upheld, nowS);
  let chain: OnChainBadge | null = null;
  if (local) chain = await deps.onChain(key).catch(() => null);
  const confirmed = local && (chain === null || chain.status === "valid") ? local : null;

  const biz = confirmed ? businessIndex(businesses, badges, upheld, nowS).get(key) : undefined;
  return {
    ok: true,
    value: {
      marketplace,
      handle,
      verifiedSeller: confirmed
        ? { since: iso(confirmed.verifiedAt), expires: iso(confirmed.expiresAt), attestation: confirmed.attestation, onChain: chain ? chain.status : "not_checked" }
        : null,
      verifiedBusiness: biz ? { name: biz.name, country: biz.country, domain: biz.domain ?? null, profile: `${deps.baseUrl}/business/${biz.id}` } : null,
      upheldReports: upheld.get(key) ?? 0,
      findings: findings.map((f) => ({
        category: f.category,
        status: f.status,
        decidedAt: iso(f.decidedAt),
        reversedAt: f.reversedAt ? iso(f.reversedAt) : null,
        attestation: f.attestation ?? null,
        sellerReplied: !!f.reply,
      })),
      checkedAt: iso(nowS),
      meaning: SELLER_MEANING,
    },
  };
}

// --- business ------------------------------------------------------------------------------

export interface BusinessRecord {
  found: boolean;
  status: "verified" | "suspended" | "expired" | "incomplete" | null;
  statusReason: string | null;
  registeredName: string | null;
  country: string | null;
  vat: { masked: string; checkedAt: string } | null;
  website: { domain: string; provedAt: string } | null;
  validUntil: string | null;
  accounts: { marketplace: string; handle: string; verifiedSince: string; active: boolean; upheldReports: number; attestation: string }[];
  profile: string | null;
  checkedAt: string;
  meaning: string;
}

export async function businessRecord(query: { id?: string; vatCountry?: string; vatNumber?: string; domain?: string }, deps: ApiDeps): Promise<ApiReply<BusinessRecord>> {
  const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const vat = query.vatNumber ? normaliseVat(query.vatCountry ?? "", query.vatNumber) : null;
  const domain = query.domain ? normaliseDomain(query.domain) : null;
  if (query.vatNumber && !vat) return { ok: false, status: 400, error: "vatCountry must be an EU VAT prefix (e.g. DE, EL) and vatNumber a VAT number." };
  if (query.domain && !domain) return { ok: false, status: 400, error: "domain must be a domain, like example-shop.de." };
  if (!query.id && !vat && !domain) return { ok: false, status: 400, error: "Pass one of: id, vatCountry+vatNumber, domain." };

  const [businesses, badges, upheld] = await Promise.all([deps.businesses(), deps.badges(), deps.upheld()]);
  const b = Object.values(businesses).find(
    (x) =>
      (query.id && x.id === query.id) ||
      (vat && x.vat?.country === vat.country && x.vat.number === vat.number) ||
      (domain && x.domain?.name === domain),
  );
  const empty: BusinessRecord = {
    found: false, status: null, statusReason: null, registeredName: null, country: null, vat: null, website: null, validUntil: null,
    accounts: [], profile: null, checkedAt: iso(nowS), meaning: BUSINESS_MEANING,
  };
  if (!b) return { ok: true, value: empty };

  const v = businessView(b, badges, upheld, nowS);
  return {
    ok: true,
    value: {
      found: true,
      status: v.status,
      statusReason: v.statusReason ?? null,
      registeredName: v.registeredName,
      country: v.country ? VIES_COUNTRIES[v.country] ?? v.country : null,
      vat: v.vatMasked && v.vatCheckedAt ? { masked: v.vatMasked, checkedAt: iso(v.vatCheckedAt) } : null,
      website: v.domain && v.domainVerifiedAt ? { domain: v.domain, provedAt: iso(v.domainVerifiedAt) } : null,
      validUntil: v.status === "verified" && v.expiresAt ? iso(v.expiresAt) : null,
      accounts: v.accounts.map((a) => ({ marketplace: a.source, handle: a.handle, verifiedSince: iso(a.verifiedAt), active: a.active, upheldReports: a.upheldReports, attestation: a.attestation })),
      profile: `${deps.baseUrl}/business/${b.id}`,
      checkedAt: iso(nowS),
      meaning: BUSINESS_MEANING,
    },
  };
}
