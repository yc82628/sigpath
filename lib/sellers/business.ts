/**
 * lib/sellers/business.ts — the verified-business tier.
 *
 * A verified seller badge proves one marketplace account, its wallet and a
 * live person. A verified BUSINESS adds who is behind it, each fact with its
 * own evidence:
 *
 *   ACCOUNTS  Every marketplace account whose verified badge sits in the same
 *             wallet. One wallet across eBay and Etsy is proof of common
 *             control, so linking needs no extra step, and SigPath never
 *             guesses that two accounts belong together.
 *   VAT       The EU VAT number, checked live against the EU's VIES register.
 *             The name shown is the register's, never what the seller typed.
 *             Some countries (Germany among them) don't publish names through
 *             VIES; then the number is valid but the name is "not published
 *             by the register", and the profile says exactly that.
 *   WEBSITE   Optional. A one-time code in the domain's DNS (a TXT record at
 *             _sigpath.<domain>) proves whoever runs the domain approved it.
 *
 * Every step is signed by the wallet, so only the badge holder can attach a
 * business to its accounts.
 *
 * WHAT IT DOES NOT CLAIM, said on the profile too: a registered business can
 * still sell a bad item. It answers "who runs this account?", not "is this
 * item genuine?". One upheld fake-product report on ANY linked account
 * suspends the business tier on all of them.
 */

import { createHmac } from "crypto";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { badgeFor, type BadgeEntry } from "./verified-log";
import type { BusinessBadge } from "../marketplace/label";
import type { Flag } from "../marketplace/anomaly";
import type { Listing } from "../marketplace/types";
import { sellerKey } from "../marketplace/types";
import { businessMessage } from "./business-message";
import { dataDir } from "../data-dir";

type Env = Record<string, string | undefined>;

/** A business verification lasts a year from its VAT check, like the badge. */
export const BUSINESS_TTL_SECS = 365 * 86400;
/** A signed request must be this fresh. */
export const SIGNATURE_WINDOW_MS = 10 * 60 * 1000;

// --- VAT (EU VIES) ------------------------------------------------------------------

/** EU VAT prefixes VIES answers for. Greece is EL; Northern Ireland is XI. */
export const VIES_COUNTRIES: Record<string, string> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", CY: "Cyprus", CZ: "Czechia", DE: "Germany", DK: "Denmark",
  EE: "Estonia", EL: "Greece", ES: "Spain", FI: "Finland", FR: "France", HR: "Croatia", HU: "Hungary",
  IE: "Ireland", IT: "Italy", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", MT: "Malta", NL: "Netherlands",
  PL: "Poland", PT: "Portugal", RO: "Romania", SE: "Sweden", SI: "Slovenia", SK: "Slovakia", XI: "Northern Ireland",
};

export function normaliseVat(country: string, number: string): { country: string; number: string } | null {
  const c = country.trim().toUpperCase().replace(/^GR$/, "EL");
  if (!VIES_COUNTRIES[c]) return null;
  let n = number.toUpperCase().replace(/[\s.\-]/g, "");
  if (n.startsWith(c)) n = n.slice(c.length);
  if (c === "EL" && n.startsWith("GR")) n = n.slice(2);
  return /^[A-Z0-9]{2,12}$/.test(n) ? { country: c, number: n } : null;
}

export type VatCheck =
  | { status: "valid"; registeredName: string | null }
  | { status: "invalid" }
  | { status: "unavailable"; detail: string };

const VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

/** Ask the EU register. "---" from VIES means the country does not publish that field. */
export async function checkVat(country: string, number: string, fetchImpl: typeof fetch = fetch): Promise<VatCheck> {
  try {
    const res = await fetchImpl(VIES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ countryCode: country, vatNumber: number }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { valid?: boolean; name?: string; errorWrappers?: { error?: string }[] } | null;
    if (!res.ok || !body || typeof body.valid !== "boolean") {
      return { status: "unavailable", detail: body?.errorWrappers?.[0]?.error ?? `register answered ${res.status}` };
    }
    if (!body.valid) return { status: "invalid" };
    const name = body.name?.trim();
    return { status: "valid", registeredName: name && name !== "---" ? name : null };
  } catch (err) {
    return { status: "unavailable", detail: err instanceof Error ? err.name : "network error" };
  }
}

/** "DE•••••6789": enough to recognise, not the whole number on every page. */
export function maskVat(country: string, number: string): string {
  return number.length <= 4 ? `${country}${number}` : `${country}${"•".repeat(number.length - 4)}${number.slice(-4)}`;
}

// --- website (DNS TXT) -------------------------------------------------------------------

export function normaliseDomain(input: string): string | null {
  let d = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "").replace(/\.$/, "");
  if (d.includes("@") || d.includes(":")) return null;
  d = d.replace(/\s/g, "");
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) ? d : null;
}

function secret(env: Env): Buffer | null {
  const s = env.QUOTE_SECRET?.trim();
  return s && s.length >= 32 ? Buffer.from(s, "utf8") : null;
}

/** The record a domain owner adds. Bound to wallet AND domain, so it proves nothing anywhere else. */
export function domainRecord(wallet: string, domain: string, env: Env = process.env): { name: string; value: string } | null {
  const k = secret(env);
  if (!k) return null;
  const token = createHmac("sha256", k).update("sigpath-domain-v1\n").update(`${wallet}\n${domain}`).digest("base64url").slice(0, 24);
  return { name: `_sigpath.${domain}`, value: `sigpath-verify=${token}` };
}

export type ResolveTxt = (name: string) => Promise<string[][]>;

/** Is the record there? DNS errors (no such name, no TXT) are simply "not yet". */
export async function domainHasRecord(record: { name: string; value: string }, resolveTxt: ResolveTxt): Promise<boolean> {
  try {
    const rows = await resolveTxt(record.name);
    return rows.some((chunks) => chunks.join("").trim() === record.value);
  } catch {
    return false;
  }
}

// --- wallet-signed steps -----------------------------------------------------------------

export { businessMessage };

export function verifyBusinessSignature(
  action: string,
  wallet: string,
  time: string,
  signatureB64: string,
  now = Date.now(),
): { ok: true } | { ok: false; error: string } {
  const t = Date.parse(time);
  if (!Number.isFinite(t) || Math.abs(now - t) > SIGNATURE_WINDOW_MS) return { ok: false, error: "That signature has expired. Sign again." };
  try {
    const pub = new PublicKey(wallet).toBytes();
    const sig = Buffer.from(signatureB64, "base64");
    if (sig.length !== 64) return { ok: false, error: "That isn't a valid signature." };
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(businessMessage(action, wallet, time)), sig, pub);
    return ok ? { ok: true } : { ok: false, error: "The signature doesn't match this wallet." };
  } catch {
    return { ok: false, error: "That isn't a valid wallet address." };
  }
}

// --- the record ----------------------------------------------------------------------

export interface Business {
  /** Public id for the profile URL. */
  id: string;
  wallet: string;
  vat?: { country: string; number: string; registeredName: string | null; checkedAt: number };
  domain?: { name: string; verifiedAt: number };
  createdAt: number;
  /**
   * The Solana attestation recording this business (chains/solana/sas-business.ts).
   * `error` when publishing failed: the business is still verified, and
   * `reports-admin publish-business` retries. `revokedAt` once closed on suspension.
   */
  onChain?: { attestation: string; signature?: string; publishedAt: number; error?: string; revokedAt?: number; revokeSignature?: string };
}

export class BusinessLog {
  constructor(private readonly file: string) {}

  static fromEnv(env: Env = process.env): BusinessLog {
    return new BusinessLog(env.BUSINESSES_FILE?.trim() || join(dataDir(env), "sellers", "businesses.json"));
  }

  /** Keyed by owner wallet. */
  async all(): Promise<Record<string, Business>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  async byWallet(wallet: string): Promise<Business | null> {
    return (await this.all())[wallet] ?? null;
  }

  async byId(id: string): Promise<Business | null> {
    return Object.values(await this.all()).find((b) => b.id === id) ?? null;
  }

  private async write(all: Record<string, Business>) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async update(wallet: string, change: (b: Business) => Business, nowS = Math.floor(Date.now() / 1000)): Promise<Business> {
    const all = await this.all();
    const current = all[wallet] ?? { id: `b_${randomBytes(6).toString("base64url")}`, wallet, createdAt: nowS };
    all[wallet] = change(current);
    await this.write(all);
    return all[wallet];
  }

  async remove(wallet: string): Promise<boolean> {
    const all = await this.all();
    if (!all[wallet]) return false;
    delete all[wallet];
    await this.write(all);
    return true;
  }
}

// --- what a business is, right now ------------------------------------------------------------

export interface LinkedAccount {
  sellerKey: string;
  source: string;
  handle: string;
  verifiedAt: number;
  /** Badge currently shown (not revoked, not lapsed, no upheld report). */
  active: boolean;
  upheldReports: number;
  attestation: string;
}

export type BusinessStatus = "verified" | "suspended" | "expired" | "incomplete";

export interface BusinessView {
  id: string;
  status: BusinessStatus;
  /** Why it isn't verified, for the profile. */
  statusReason?: string;
  registeredName: string | null;
  country?: string;
  countryName?: string;
  vatMasked?: string;
  vatCheckedAt?: number;
  domain?: string;
  domainVerifiedAt?: number;
  expiresAt?: number;
  accounts: LinkedAccount[];
  onChain: Business["onChain"] | null;
}

export function businessView(
  b: Business,
  badges: Record<string, BadgeEntry>,
  upheld: ReadonlyMap<string, number>,
  nowS = Math.floor(Date.now() / 1000),
): BusinessView {
  const accounts: LinkedAccount[] = Object.entries(badges)
    .filter(([, e]) => e.current.wallet === b.wallet)
    .map(([key, e]) => {
      const colon = key.indexOf(":");
      return {
        sellerKey: key,
        source: key.slice(0, colon),
        handle: key.slice(colon + 1),
        verifiedAt: e.current.verifiedAt,
        active: badgeFor(key, badges, upheld, nowS) !== null,
        upheldReports: upheld.get(key) ?? 0,
        attestation: e.current.attestation,
      };
    });
  const expiresAt = b.vat ? b.vat.checkedAt + BUSINESS_TTL_SECS : undefined;
  let status: BusinessStatus = "verified";
  let statusReason: string | undefined;
  if (accounts.some((a) => a.upheldReports > 0)) {
    status = "suspended";
    statusReason = "A verified buyer's fake-product report against one of its accounts was upheld.";
  } else if (!b.vat) {
    status = "incomplete";
    statusReason = "No VAT number has been checked yet.";
  } else if (expiresAt !== undefined && nowS >= expiresAt) {
    status = "expired";
    statusReason = "The VAT check is more than a year old.";
  } else if (!accounts.some((a) => a.active)) {
    status = "incomplete";
    statusReason = "None of its marketplace accounts currently holds a verified-seller badge.";
  }
  return {
    id: b.id,
    status,
    statusReason,
    registeredName: b.vat?.registeredName ?? null,
    country: b.vat?.country,
    countryName: b.vat ? VIES_COUNTRIES[b.vat.country] : undefined,
    vatMasked: b.vat ? maskVat(b.vat.country, b.vat.number) : undefined,
    vatCheckedAt: b.vat?.checkedAt,
    domain: b.domain?.name,
    domainVerifiedAt: b.domain?.verifiedAt,
    expiresAt,
    accounts,
    onChain: b.onChain ?? null,
  };
}

/** Every marketplace account of a VERIFIED business, keyed by sellerKey, for search. */
export function businessIndex(
  businesses: Record<string, Business>,
  badges: Record<string, BadgeEntry>,
  upheld: ReadonlyMap<string, number>,
  nowS = Math.floor(Date.now() / 1000),
): Map<string, BusinessBadge> {
  const index = new Map<string, BusinessBadge>();
  for (const b of Object.values(businesses)) {
    const v = businessView(b, badges, upheld, nowS);
    if (v.status !== "verified" || !v.country) continue;
    const badge: BusinessBadge = { id: v.id, name: v.registeredName, country: v.countryName ?? v.country, domain: v.domain };
    for (const a of v.accounts) if (a.active) index.set(a.sellerKey, badge);
  }
  return index;
}

/**
 * Photo theft across marketplaces. analyse() can't flag a photo shared across
 * two marketplaces, because one seller cross-posting looks exactly like theft.
 * A verified business changes that: its accounts are linked, so its photo
 * under an account it has NOT linked is worth saying out loud. The wording
 * states what was observed, not what the seller did.
 */
export function verifiedPhotoFlags(listings: Listing[], index: ReadonlyMap<string, BusinessBadge>): Flag[] {
  const ownerOfPhoto = new Map<string, { business: BusinessBadge; source: string }>();
  for (const l of listings) {
    const b = l.imageHash ? index.get(sellerKey(l.source, l.seller.handle)) : undefined;
    if (b && l.imageHash && !ownerOfPhoto.has(l.imageHash)) ownerOfPhoto.set(l.imageHash, { business: b, source: l.source });
  }
  const flags: Flag[] = [];
  for (const l of listings) {
    const owner = l.imageHash ? ownerOfPhoto.get(l.imageHash) : undefined;
    if (!owner) continue;
    // Same marketplace is already covered by the duplicate-photo check in analyse().
    if (owner.source === l.source) continue;
    const mine = index.get(sellerKey(l.source, l.seller.handle));
    if (mine?.id === owner.business.id) continue;
    flags.push({
      source: l.source,
      listingId: l.id,
      kind: "photo_of_verified_business",
      message: "This photo is also used by a verified business on another marketplace, and this account isn't linked to that business.",
    });
  }
  return flags;
}
