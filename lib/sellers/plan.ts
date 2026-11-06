/**
 * lib/sellers/plan.ts — the Verified business plan: what it costs, how it is
 * paid, and how a payment is checked.
 *
 * WHO PAYS
 * Only the verified-BUSINESS tier (business.ts). A seller's own verified badge
 * stays free, so there is always a free path to trust; shoppers pay nothing
 * anywhere (lib/checkout/fee.ts).
 *
 * WHAT IT BUYS, AND WHAT IT DOESN'T
 * The business check, the "✓ Verified business" badge on its accounts and its
 * public profile, while the plan runs. It buys no place in search: results are
 * ordered by the deal, the same for everyone (lib/marketplace/search.ts). And
 * it buys no verdict: a paying business that fails the checks gets no badge,
 * and one upheld fake-product report suspends it, paid or not.
 *
 * THE PRICE
 * Per month, or per year at 10% off twelve months. An opening offer runs until
 * BUSINESS_OPENING_OFFER_UNTIL (YYYY-MM-DD, that day included); unset, it runs.
 * Each payment is charged at the price of the day it is made; renewing later
 * costs the price of that day.
 *
 * HOW IT IS PAID
 * On Solana, from the wallet that holds the business's badges, to SigPath's
 * operator wallet, in either of Circle's stablecoins:
 *   EURC  the euro price, one to one: no exchange rate, nothing rounded. EU
 *         e-money under MiCA, and what a German business thinks in.
 *   USDC  the euro price at the ECB rate, the same rate and rounding as the
 *         checkout (lib/checkout/fx.ts).
 * The transfer carries a
 * one-time reference key (the Solana Pay pattern), so the server finds the
 * payment on chain by that key and checks it there, never trusting the
 * browser's word that it paid.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import * as orders from "../chains/solana/orders";
import { associatedTokenAddress, createAtaIdempotentIx, transferCheckedIx } from "../chains/solana/spl";
import type { Business } from "./business";

type Env = Record<string, string | undefined>;

/**
 * Circle's EURC: the same address on Solana devnet and mainnet (checked on both,
 * 2026-11-06: classic SPL Token, 6 decimals), so nothing changes at launch.
 */
export const EURC_MINT = new PublicKey("HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr");
export type PayToken = "EURC" | "USDC";
export const PAY_TOKENS: Record<PayToken, { mint: PublicKey; decimals: number }> = {
  EURC: { mint: EURC_MINT, decimals: 6 },
  USDC: { mint: orders.USDC_MINT, decimals: orders.USDC_DECIMALS },
};

/** Euro cents in EURC base units: one euro is one EURC, six decimals. */
export function eurcBaseUnits(eurCents: number): bigint {
  return BigInt(eurCents) * 10_000n;
}

export type Period = "month" | "year";
export const PERIODS: Period[] = ["month", "year"];

/** €9.99 a month. */
export const MONTHLY_CENTS = 999;
/** €7.99 a month while the opening offer runs. */
export const OPENING_MONTHLY_CENTS = 799;
/** A year costs twelve months less this. */
export const YEARLY_DISCOUNT_PCT = 10;
/** What a payment adds to the plan. */
export const PERIOD_DAYS: Record<Period, number> = { month: 30, year: 365 };

/** Twelve months less the yearly discount, to the cent: 999 -> 10789 (€107.89), 799 -> 8629. */
export function yearlyCents(monthly: number): number {
  return Math.round((monthly * 12 * (100 - YEARLY_DISCOUNT_PCT)) / 100);
}

/** Whether the opening offer still runs: until the end of BUSINESS_OPENING_OFFER_UNTIL (UTC), or always when unset. */
export function openingOffer(env: Env = process.env, now = Date.now()): boolean {
  const until = env.BUSINESS_OPENING_OFFER_UNTIL?.trim();
  if (!until) return true;
  const end = Date.parse(`${until}T23:59:59.999Z`);
  return !Number.isFinite(end) || now <= end;
}

export interface PlanPrices {
  /** In euro cents. */
  month: number;
  year: number;
  /** The opening offer is on: `regular` is what it becomes. */
  opening: boolean;
  regular: { month: number; year: number };
}

export function planPrices(env: Env = process.env, now = Date.now()): PlanPrices {
  const opening = openingOffer(env, now);
  const monthly = opening ? OPENING_MONTHLY_CENTS : MONTHLY_CENTS;
  return { month: monthly, year: yearlyCents(monthly), opening, regular: { month: MONTHLY_CENTS, year: yearlyCents(MONTHLY_CENTS) } };
}

/** Whether the plan runs at this moment. */
export function planActive(b: Pick<Business, "plan">, nowS: number): boolean {
  return !!b.plan && nowS < b.plan.paidUntil;
}

/** A payment's period added after the plan's current end, or after now if it has run out. */
export function extendedUntil(b: Pick<Business, "plan">, period: Period, nowS: number): number {
  return Math.max(nowS, b.plan?.paidUntil ?? 0) + PERIOD_DAYS[period] * 86400;
}

// --- the payment request -------------------------------------------------------------

/** What the server signed when it built a payment: who pays, how much, in what, for what, found by which key. */
export interface PlanQuote {
  /** Business wallet. */
  w: string;
  p: Period;
  /** The stablecoin paid in. */
  t: PayToken;
  /** Its base units, as a string (bigint). */
  u: string;
  /** Euro cents charged. */
  c: number;
  /** The reference key on the transfer. */
  r: string;
  /** Unix seconds the payment had to be sent by. */
  e: number;
}

/** A transaction's blockhash lasts about a minute; this is generous. */
export const PAY_WINDOW_SECS = 15 * 60;
/** A payment sent in time can still be confirmed this long after, if the page was closed meanwhile. */
export const CONFIRM_GRACE_SECS = 7 * 86400;
// Its own domain string: a plan quote can't pass as a checkout quote, a claim or a seller link.
const DOMAIN = "sigpath-business-plan-v1";

function secret(env: Env): Buffer | null {
  const s = env.QUOTE_SECRET?.trim();
  return s && s.length >= 32 ? Buffer.from(s, "utf8") : null;
}
const mac = (k: Buffer, payload: string) => createHmac("sha256", k).update(`${DOMAIN}\n`).update(payload).digest();

export function signPlanQuote(q: PlanQuote, env: Env = process.env): string | null {
  const k = secret(env);
  if (!k) return null;
  const payload = Buffer.from(JSON.stringify(q), "utf8").toString("base64url");
  return `${payload}.${mac(k, payload).toString("base64url")}`;
}

/** The quote, if the server signed it and it can still be confirmed. */
export function openPlanQuote(token: unknown, env: Env = process.env, nowS = Math.floor(Date.now() / 1000)): PlanQuote | null {
  const k = secret(env);
  if (!k || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  // Compared as text, not decoded bytes: base64url's last character has spare bits, and a token
  // differing only in those must not count as the same token.
  const want = Buffer.from(mac(k, payload).toString("base64url"), "utf8");
  const got = Buffer.from(sig, "utf8");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const q = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PlanQuote;
    if (!PERIODS.includes(q.p) || !(q.t in PAY_TOKENS) || typeof q.e !== "number" || !/^\d+$/.test(q.u)) return null;
    return nowS <= q.e + CONFIRM_GRACE_SECS ? q : null;
  } catch {
    return null;
  }
}

/**
 * The payment, unsigned, for the business's wallet to sign and send: the
 * stablecoin from its token account to the operator's, with the reference key
 * riding along as a read-only account so the payment can be found by it.
 */
export function planTransaction(args: {
  wallet: PublicKey;
  token: PayToken;
  amount: bigint;
  reference: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
}): Transaction {
  const { mint, decimals } = PAY_TOKENS[args.token];
  const tx = new Transaction({ feePayer: args.wallet, blockhash: args.blockhash, lastValidBlockHeight: args.lastValidBlockHeight });
  // The operator's account for this coin exists once it has been paid anything; creating it is a no-op then.
  tx.add(createAtaIdempotentIx(args.wallet, orders.OPERATOR, mint));
  const transfer = transferCheckedIx({
    source: associatedTokenAddress(args.wallet, mint),
    mint,
    destination: associatedTokenAddress(orders.OPERATOR, mint),
    owner: args.wallet,
    amount: args.amount,
    decimals,
  });
  transfer.keys.push({ pubkey: args.reference, isSigner: false, isWritable: false });
  tx.add(transfer);
  return tx;
}

// --- checking a payment on chain -----------------------------------------------------

/** The parts of a confirmed transaction the check reads (getTransaction's meta). */
export interface ChainPayment {
  signature: string;
  err: unknown;
  /** Unix seconds, when the chain has it. */
  blockTime?: number | null;
  pre: TokenBalance[];
  post: TokenBalance[];
}
export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  amount: string;
}

/** How much of a mint an owner gained (positive) or spent (negative) in a transaction. */
function delta(p: ChainPayment, owner: string, mint: string): bigint {
  const sum = (list: TokenBalance[]) => list.filter((b) => b.owner === owner && b.mint === mint).reduce((t, b) => t + BigInt(b.amount), 0n);
  return sum(p.post) - sum(p.pre);
}

/**
 * Whether a transaction is the quoted payment: it succeeded, the business's
 * wallet spent at least the quoted amount of the quoted coin and the operator
 * received at least that, and it landed before the quote ran out.
 */
export function isPlanPayment(p: ChainPayment, q: PlanQuote): boolean {
  if (p.err) return false;
  const amount = BigInt(q.u);
  const mint = PAY_TOKENS[q.t].mint.toBase58();
  if (delta(p, q.w, mint) > -amount) return false;
  if (delta(p, orders.OPERATOR.toBase58(), mint) < amount) return false;
  return p.blockTime == null || p.blockTime <= q.e + 120;
}
