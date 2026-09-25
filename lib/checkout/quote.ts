/**
 * lib/checkout/quote.ts — price quotes the browser cannot edit.
 *
 * THE PROBLEM
 * The checkout page needs to know what the item costs. If it takes that from
 * the URL or a form field, a shopper changes "249.00" to "1.00" and the server
 * happily builds an order for one euro. The escrow would still protect the
 * operator — they would refund rather than buy — but a checkout that accepts
 * whatever price it is handed is broken, and every tampered order is a refund
 * to process by hand.
 *
 * THE FIX
 * When the search page renders a listing, the SERVER signs the facts it just
 * fetched — source, id, url, title, total price, currency — with an HMAC key
 * only the server holds, plus a short expiry. The checkout accepts nothing
 * else: it verifies the signature and reads the price out of the token. Change
 * one character and the signature fails.
 *
 * Stateless on purpose: nothing is stored per quote, which fits a site with no
 * accounts and no sessions.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** A quote is good for this long. Prices move; a stale one is re-fetched by searching again. */
export const QUOTE_TTL_SECONDS = 30 * 60;

export interface QuotedListing {
  source: string;
  id: string;
  url: string;
  title: string;
  /** Total the buyer pays (item + shipping), integer minor units. */
  amount: number;
  currency: string;
  /** Unix seconds. */
  expiresAt: number;
}

export type QuoteResult =
  | { ok: true; listing: QuotedListing }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "not_configured" };

function secret(env: Record<string, string | undefined>): Buffer | null {
  const s = env.QUOTE_SECRET?.trim();
  // A short secret is a guessable one. Refuse rather than sign weakly.
  return s && s.length >= 32 ? Buffer.from(s, "utf8") : null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function mac(key: Buffer, payload: string): Buffer {
  // Domain-separated, so a quote signature can never be replayed as some other
  // kind of token signed with the same key.
  return createHmac("sha256", key).update("sigpath-quote-v1\n").update(payload).digest();
}

/** Whether quotes can be signed at all — the search page offers checkout only if so. */
export function quoteSigningConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return secret(env) !== null;
}

/** Sign a quote. Returns null when QUOTE_SECRET is not configured. */
export function signQuote(
  listing: Omit<QuotedListing, "expiresAt">,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): string | null {
  const key = secret(env);
  if (!key) return null;
  const body: QuotedListing = { ...listing, expiresAt: Math.floor(now / 1000) + QUOTE_TTL_SECONDS };
  const payload = b64url(Buffer.from(JSON.stringify(body), "utf8"));
  return `${payload}.${b64url(mac(key, payload))}`;
}

export function verifyQuote(
  token: string,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): QuoteResult {
  const key = secret(env);
  if (!key) return { ok: false, reason: "not_configured" };

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts;

  const expected = mac(key, payload);
  const given = fromB64url(sig);
  // Constant-time: a byte-by-byte comparison leaks how much of a forged
  // signature was right.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let listing: QuotedListing;
  try {
    listing = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof listing.amount !== "number" ||
    !Number.isInteger(listing.amount) ||
    listing.amount <= 0 ||
    typeof listing.currency !== "string" ||
    typeof listing.expiresAt !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(now / 1000) > listing.expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, listing };
}
