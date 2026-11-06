/**
 * lib/checkout/fee.ts — SigPath's service fee on a USDC checkout.
 *
 * NONE BY DEFAULT (2026-11-06). Shoppers come to SigPath for the best deal, so
 * they pay nothing: not for the search, the extension, nor this checkout.
 * SIGPATH_FEE_BPS can still set one, e.g. to cover converting USDC to euros and
 * paying the shop once the checkout runs on real money; until then it is
 * devnet, test money only.
 *
 * When there is one, it is a percentage of the item's USDC price, paid into the escrow with it. The
 * operator receives price + fee when the order is fulfilled; a refund returns
 * both to the buyer, so a cancelled order costs the shopper nothing.
 *
 * It is a SERVICE FEE, never shown as "VAT" or a tax: those are the state's,
 * and a fee dressed as one would mislead the buyer.
 *
 * The rate is signed into each quote (quote.ts), so the fee a shopper sees on
 * the checkout page is the fee charged even if the setting changes meanwhile.
 */

/** None, in basis points (1 bp = 0.01%; 200 would be 2%). */
export const DEFAULT_FEE_BPS = 0;
/** A setting above 10% is a typo, not a price. */
export const MAX_FEE_BPS = 1000;

/** SIGPATH_FEE_BPS, e.g. 200 for 2% or 150 for 1.5%. Anything invalid means the default: no fee. */
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
