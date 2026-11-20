/**
 * lib/chains/solana/tokens.ts — the two coins a shopper can pay with.
 *
 * Circle's stablecoins, both classic SPL tokens with six decimals:
 *   EURC  a digital euro. A euro price is paid one to one: 150,00 € is
 *         150 EURC, with no exchange rate in between.
 *   USDC  a digital dollar. A euro price is converted at the ECB's daily
 *         reference rate (lib/checkout/fx.ts), so 150,00 € might be 164.88 USDC:
 *         the same value, counted in dollars.
 *
 * No node or web3 imports, so the browser bundle can use it too. The escrow
 * program accepts exactly these two mints (is_accepted_mint in
 * programs/sigpath_orders/src/lib.rs).
 */

export type PayToken = "EURC" | "USDC";
export const PAY_TOKEN_LIST: readonly PayToken[] = ["EURC", "USDC"];

export const PAY_TOKENS: Record<PayToken, { mint: string; decimals: number; currency: "EUR" | "USD" }> = {
  // The same address on devnet and mainnet (checked 2026-11-06).
  EURC: { mint: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", decimals: 6, currency: "EUR" },
  // Circle's devnet USDC.
  USDC: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, currency: "USD" },
};

/** "eurc", "EURC" -> "EURC"; anything else -> null. */
export function parsePayToken(value: unknown): PayToken | null {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  return v === "EURC" || v === "USDC" ? v : null;
}

/**
 * The coin a checkout starts with: EURC when every item is priced in euros
 * (nothing to convert), USDC when one is in dollars. The shopper can switch.
 */
export function defaultPayToken(currencies: readonly string[]): PayToken {
  return currencies.length > 0 && currencies.every((c) => c.toUpperCase() === "EUR") ? "EURC" : "USDC";
}

/** The coin a mint stands for, or null for any other mint. */
export function tokenForMint(mint: string): PayToken | null {
  return (Object.keys(PAY_TOKENS) as PayToken[]).find((t) => PAY_TOKENS[t].mint === mint) ?? null;
}
