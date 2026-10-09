/**
 * lib/checkout/fee.ts — SigPath's service fee on a USDC checkout.
 *
 * A percentage of the item's USDC price, paid into the escrow with it. The
 * operator receives price + fee when the order is fulfilled; a refund returns
 * both to the buyer, so a cancelled order costs the shopper nothing.
 *
 * It is a SERVICE FEE, never shown as "VAT" or a tax: those are the state's,
 * and a fee dressed as one would mislead the buyer.
 *
 * The rate is signed into each quote (quote.ts), so the fee a shopper sees on
 * the checkout page is the fee charged even if the setting changes meanwhile.
 */

/** 2%, in basis points (1 bp = 0.01%). */
export const DEFAULT_FEE_BPS = 200;
/** A setting above 10% is a typo, not a price. */
export const MAX_FEE_BPS = 1000;

/** SIGPATH_FEE_BPS, e.g. 200 for 2% or 150 for 1.5%. Anything invalid means the default. */
export function serviceFeeBps(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SIGPATH_FEE_BPS?.trim();
  if (!raw) return DEFAULT_FEE_BPS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_FEE_BPS ? n : DEFAULT_FEE_BPS;
}

/**
 * The fee on a USDC price (base units), rounded UP to the smallest unit, so
 * integer division can never turn 2% into slightly less.
 */
export function withServiceFee(price: bigint, bps: number): { price: bigint; fee: bigint; total: bigint } {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) throw new Error("Invalid service fee.");
  const fee = (price * BigInt(bps) + 9_999n) / 10_000n;
  return { price, fee, total: price + fee };
}

/** "2%", "1.5%" */
export function formatFeeRate(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
