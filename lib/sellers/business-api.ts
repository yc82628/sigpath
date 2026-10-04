/**
 * lib/sellers/business-api.ts — the verified-business steps, as plain functions.
 *
 * The routes under app/api/business are thin wrappers around these, so every
 * rule (who may attach a business, what the register must say, what DNS must
 * show) is tested here without a server, a register or a DNS lookup.
 *
 * Each step that changes the record is signed by the wallet that holds the
 * verified-seller badges, over a message naming exactly what it approves.
 */

import type { BadgeEntry } from "./verified-log";
import type { PublishBusiness } from "./business-chain";
import type { Business } from "./business";
import {
  BusinessLog,
  businessView,
  checkVat,
  domainHasRecord,
  domainRecord,
  normaliseDomain,
  normaliseVat,
  verifyBusinessSignature,
  type BusinessView,
  type ResolveTxt,
} from "./business";

type Env = Record<string, string | undefined>;
export type Reply<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface BusinessDeps {
  log: BusinessLog;
  badges: () => Promise<Record<string, BadgeEntry>>;
  upheld: () => Promise<ReadonlyMap<string, number>>;
  fetchImpl?: typeof fetch;
  resolveTxt: ResolveTxt;
  env?: Env;
  now?: () => number;
  /** Record the business on Solana (business-chain.ts). Absent: off-chain only. */
  publish?: PublishBusiness;
}

export interface SignedStep {
  wallet: string;
  time: string;
  signature: string;
}

import { vatAction, domainAction } from "./business-message";
export { vatAction, domainAction };

export interface BusinessStatus {
  wallet: string;
  /** This wallet's verified accounts, active or not. */
  accounts: BusinessView["accounts"];
  business: BusinessView | null;
}

/**
 * After a change, publish the business on chain if it is verified. A chain
 * failure is recorded on the business, never thrown: verification stands.
 */
async function settle(b: Business, deps: BusinessDeps, nowS: number): Promise<BusinessView> {
  const view = businessView(b, await deps.badges(), await deps.upheld(), nowS);
  if (view.status !== "verified" || !deps.publish) return view;
  const onChain = await deps.publish(b, view).catch((e: unknown) => ({ attestation: b.onChain?.attestation ?? "", publishedAt: nowS, error: e instanceof Error ? e.message : String(e) }));
  const updated = await deps.log.update(b.wallet, (cur) => ({ ...cur, onChain }), nowS);
  return { ...view, onChain: updated.onChain ?? null };
}

export async function businessStatus(wallet: string, deps: BusinessDeps): Promise<BusinessStatus> {
  const [badges, upheld, business] = await Promise.all([deps.badges(), deps.upheld(), deps.log.byWallet(wallet)]);
  const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const view = businessView(business ?? { id: "", wallet, createdAt: nowS }, badges, upheld, nowS);
  return { wallet, accounts: view.accounts, business: business ? view : null };
}

/** The wallet must hold at least one shown badge, and no account of it may have an upheld report. */
async function eligible(wallet: string, deps: BusinessDeps): Promise<Reply<null>> {
  const { accounts } = await businessStatus(wallet, deps);
  if (accounts.some((a) => a.upheldReports > 0)) {
    return { ok: false, status: 403, error: "An account linked to this wallet has an upheld fake-product report, so it can't be verified as a business." };
  }
  if (!accounts.some((a) => a.active)) {
    return { ok: false, status: 403, error: "Verify at least one marketplace account with this wallet first (Become a verified seller)." };
  }
  return { ok: true, value: null };
}

export async function submitVat(
  input: SignedStep & { country: string; vatNumber: string },
  deps: BusinessDeps,
): Promise<Reply<BusinessView>> {
  const vat = normaliseVat(input.country, input.vatNumber);
  if (!vat) return { ok: false, status: 400, error: "That doesn't look like an EU VAT number. Pick the country and enter the number." };
  const now = deps.now?.() ?? Date.now();
  const sig = verifyBusinessSignature(vatAction(vat.country, vat.number), input.wallet, input.time, input.signature, now);
  if (!sig.ok) return { ok: false, status: 401, error: sig.error };
  const elig = await eligible(input.wallet, deps);
  if (!elig.ok) return elig;

  const check = await checkVat(vat.country, vat.number, deps.fetchImpl);
  if (check.status === "invalid") return { ok: false, status: 422, error: "The EU VAT register says this number isn't valid." };
  if (check.status === "unavailable") {
    return { ok: false, status: 503, error: "The EU VAT register isn't answering right now (it happens). Please try again in a few minutes." };
  }
  const nowS = Math.floor(now / 1000);
  const b = await deps.log.update(
    input.wallet,
    (cur) => ({ ...cur, vat: { country: vat.country, number: vat.number, registeredName: check.registeredName, checkedAt: nowS } }),
    nowS,
  );
  return { ok: true, value: await settle(b, deps, nowS) };
}

export async function startDomain(input: { wallet: string; domain: string }, deps: BusinessDeps): Promise<Reply<{ domain: string; record: { name: string; value: string } }>> {
  const domain = normaliseDomain(input.domain);
  if (!domain) return { ok: false, status: 400, error: "Enter a website domain, like example-shop.de." };
  const record = domainRecord(input.wallet, domain, deps.env);
  if (!record) return { ok: false, status: 503, error: "Website checks aren't set up on this server." };
  return { ok: true, value: { domain, record } };
}

export async function verifyDomain(input: SignedStep & { domain: string }, deps: BusinessDeps): Promise<Reply<BusinessView>> {
  const domain = normaliseDomain(input.domain);
  if (!domain) return { ok: false, status: 400, error: "Enter a website domain, like example-shop.de." };
  const now = deps.now?.() ?? Date.now();
  const sig = verifyBusinessSignature(domainAction(domain), input.wallet, input.time, input.signature, now);
  if (!sig.ok) return { ok: false, status: 401, error: sig.error };
  // The website is independent evidence, so it may come before the VAT check;
  // the business still only counts as verified (and goes on chain) once VAT is checked.
  const elig = await eligible(input.wallet, deps);
  if (!elig.ok) return elig;
  const record = domainRecord(input.wallet, domain, deps.env);
  if (!record) return { ok: false, status: 503, error: "Website checks aren't set up on this server." };
  if (!(await domainHasRecord(record, deps.resolveTxt))) {
    return {
      ok: false,
      status: 422,
      error: `The record isn't showing yet. Add a TXT record named ${record.name} with the value shown, then try again (DNS changes can take a few minutes).`,
    };
  }
  const nowS = Math.floor(now / 1000);
  const b = await deps.log.update(input.wallet, (cur) => ({ ...cur, domain: { name: domain, verifiedAt: nowS } }), nowS);
  return { ok: true, value: await settle(b, deps, nowS) };
}
