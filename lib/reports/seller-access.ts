/**
 * lib/reports/seller-access.ts — private links that let a seller answer.
 *
 * THE PROBLEM
 * A right of reply is empty if the seller never hears about the report, and
 * sellers are not SigPath users: there is no account to log into, and no
 * marketplace API that lets a stranger message a seller.
 *
 * THE CHANNEL THAT ALREADY EXISTS
 * SigPath is the BUYER OF RECORD. For every fulfilled order, the operator
 * bought the item on the marketplace from exactly this seller, so the operator
 * can always reach them through that order's own messaging. The notice sent
 * there carries a link, and the link is the proof: only the real seller
 * receives messages on that order. No marketplace-specific login, no scraping.
 *
 * THE LINK
 * An HMAC-signed token naming the seller and an expiry, domain-separated from
 * price quotes though it shares QUOTE_SECRET. It is placed in the URL
 * FRAGMENT (after #), which browsers never send to a server — so the token
 * does not end up in access logs, and a proxy never sees it.
 *
 * It is a bearer credential: whoever holds the link can reply as the seller.
 * That is why it is scoped to one seller, expires, and only ever permits
 * reading reports about that seller and replying to them.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Long enough to cover the reply window and an appeal after a decision. */
export const SELLER_TOKEN_TTL_SECONDS = 45 * 24 * 3600;

function key(env: Record<string, string | undefined>): Buffer | null {
  const s = env.QUOTE_SECRET?.trim();
  return s && s.length >= 32 ? Buffer.from(s, "utf8") : null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function mac(k: Buffer, payload: string): Buffer {
  // Different domain string from quotes: a quote can never pass as a seller
  // token, or the reverse, even though both use QUOTE_SECRET.
  return createHmac("sha256", k).update("sigpath-seller-v1\n").update(payload).digest();
}

export function signSellerToken(
  sellerKey: string,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
  ttlSeconds = SELLER_TOKEN_TTL_SECONDS,
): string | null {
  const k = key(env);
  if (!k) return null;
  const payload = b64url(Buffer.from(JSON.stringify({ s: sellerKey, e: Math.floor(now / 1000) + ttlSeconds }), "utf8"));
  return `${payload}.${b64url(mac(k, payload))}`;
}

export function verifySellerToken(
  token: unknown,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): { ok: true; sellerKey: string } | { ok: false; error: string } {
  const k = key(env);
  if (!k) return { ok: false, error: "Seller access is not configured." };
  if (typeof token !== "string") return { ok: false, error: "Missing link token." };
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return { ok: false, error: "That link isn't valid." };

  const expected = mac(k, payload);
  const given = fromB64url(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, error: "That link isn't valid." };
  }
  let body: { s?: unknown; e?: unknown };
  try {
    body = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return { ok: false, error: "That link isn't valid." };
  }
  if (typeof body.s !== "string" || typeof body.e !== "number") return { ok: false, error: "That link isn't valid." };
  if (Math.floor(now / 1000) > body.e) return { ok: false, error: "That link has expired. Ask SigPath for a new one." };
  return { ok: true, sellerKey: body.s };
}

/** The page a notice links to. The token rides in the fragment, never the query. */
export function sellerLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/seller/respond#t=${token}`;
}
