/**
 * lib/onramp/moonpay.ts — "not enough USDC? buy some", through MoonPay.
 *
 * A shopper who has a bank card but not enough USDC is sent to MoonPay's own
 * buy page with everything filled in: USDC on Solana, the missing amount, euros,
 * and THEIR wallet as the destination. MoonPay handles the payment, the
 * identity checks and the delivery; SigPath never touches the money or the
 * card, and learns nothing about the purchase.
 *
 * WHY THE LINK IS SIGNED
 * A pre-filled wallet address must be signed (HMAC-SHA256 over the query
 * string, including its leading "?", keyed with the secret key, base64), or
 * MoonPay refuses it. That is what stops anyone from swapping the destination
 * wallet in a link. The secret key never leaves the server.
 * https://dev.moonpay.com/docs/on-ramp-enhance-security-using-signed-urls
 *
 * TEST KEYS ON DEVNET, LIVE KEYS ON MAINNET ONLY
 * MoonPay delivers real (mainnet) USDC. SigPath's escrow on devnet only takes
 * Circle's devnet USDC, so a live purchase there would be real money the
 * shopper can't spend here. On devnet only test keys (pk_test_/sk_test_,
 * MoonPay's sandbox, no real money) are accepted.
 */

import { createHmac } from "crypto";
import { PublicKey } from "@solana/web3.js";

/**
 * THE SWITCH. false turns the MoonPay top-up off everywhere, whatever keys the
 * host has: the checkout then offers no MoonPay button, and the endpoint answers
 * 503. Off since 2026-10-09: MoonPay rejects every link from SigPath's account
 * ("Signature check failed") until their support fixes it. Set back to true then.
 */
export const MOONPAY_ENABLED = false;

export interface MoonPayConfig {
  publishableKey: string;
  secretKey: string;
  /** buy-sandbox.moonpay.com for test keys, buy.moonpay.com for live ones. */
  base: string;
  test: boolean;
  /** MoonPay's code for USDC on Solana. */
  currencyCode: string;
}

/**
 * Null when MoonPay isn't set up, or when the keys don't belong together:
 * both test or both live, and live only when the escrow is on mainnet.
 */
export function moonPayConfig(env: Record<string, string | undefined> = process.env): MoonPayConfig | null {
  const publishableKey = env.MOONPAY_PUBLISHABLE_KEY?.trim();
  const secretKey = env.MOONPAY_SECRET_KEY?.trim();
  if (!publishableKey || !secretKey) return null;
  const test = publishableKey.startsWith("pk_test_") && secretKey.startsWith("sk_test_");
  const live = publishableKey.startsWith("pk_live_") && secretKey.startsWith("sk_live_");
  if (!test && !live) return null;
  const rpc = (env.ORDERS_RPC_URL || env.NEXT_PUBLIC_RPC_URL || "").toLowerCase();
  const mainnet = rpc.includes("mainnet");
  if (live && !mainnet) return null;
  const currencyCode = (env.MOONPAY_CURRENCY_CODE?.trim() || "usdc_sol").toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(currencyCode)) return null;
  return {
    publishableKey,
    secretKey,
    base: test ? "https://buy-sandbox.moonpay.com" : "https://buy.moonpay.com",
    test,
    currencyCode,
  };
}

/** The config the site actually uses: null while the switch above is off. */
export function moonPayAvailable(
  env: Record<string, string | undefined> = process.env,
  enabled = MOONPAY_ENABLED,
): MoonPayConfig | null {
  return enabled ? moonPayConfig(env) : null;
}

/** MoonPay's signature: base64 HMAC-SHA256 of the query string, leading "?" included. */
export function moonPaySignature(query: string, secretKey: string): string {
  if (!query.startsWith("?")) throw new Error("Sign the query string including its leading ?.");
  return createHmac("sha256", secretKey).update(query).digest("base64");
}

/**
 * The signed buy link. `usdc` is the amount to buy, in whole USDC (a shortfall
 * is rounded up to the cent); MoonPay applies its own minimum on top.
 */
export function moonPayBuyUrl(
  cfg: MoonPayConfig,
  opts: { wallet: string; usdc?: number; redirectUrl?: string },
): string {
  const wallet = new PublicKey(opts.wallet).toBase58(); // throws on anything that isn't a Solana address
  const params: [string, string][] = [
    ["apiKey", cfg.publishableKey],
    ["currencyCode", cfg.currencyCode],
    ["baseCurrencyCode", "eur"],
    ["walletAddress", wallet],
  ];
  if (opts.usdc !== undefined && Number.isFinite(opts.usdc) && opts.usdc > 0) {
    params.push(["quoteCurrencyAmount", (Math.ceil(opts.usdc * 100) / 100).toFixed(2)]);
  }
  if (opts.redirectUrl) params.push(["redirectURL", opts.redirectUrl]);
  // Values are URL-encoded BEFORE signing, so the signed bytes are the sent bytes.
  const query = "?" + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${cfg.base}${query}&signature=${encodeURIComponent(moonPaySignature(query, cfg.secretKey))}`;
}
