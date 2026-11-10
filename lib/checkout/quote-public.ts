/**
 * lib/checkout/quote-public.ts — what a signed price says, readable in the browser.
 *
 * A quote (quote.ts) is "<payload>.<signature>", the payload plain base64url
 * JSON. The browser reads it, without checking the signature it can't check,
 * for two things: when the price runs out (to say so before Pay, not after) and
 * which listing it is (to ask for a fresh price, or to rebuild a cart that
 * arrived in a link). Nothing here is trusted: the server verifies every quote
 * on every payment.
 */

export interface PublicQuote {
  source: string;
  id: string;
  title: string;
  /** The listing's own page (https only), for buying it there instead. */
  url: string | null;
  /** Unix seconds. */
  expiresAt: number;
}

export function readQuote(token: string): PublicQuote | null {
  const payload = token.split(".")[0] ?? "";
  if (!/^[A-Za-z0-9_-]{8,4000}$/.test(payload)) return null;
  try {
    const bin = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const q = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof q.source !== "string" || typeof q.id !== "string" || typeof q.title !== "string" || typeof q.expiresAt !== "number") return null;
    const url = typeof q.url === "string" && /^https:\/\//.test(q.url) ? q.url : null;
    return { source: q.source, id: q.id, title: q.title, url, expiresAt: q.expiresAt };
  } catch {
    return null;
  }
}

/** When the first of these prices runs out (unix seconds), or null if none can be read. */
export function firstExpiry(tokens: string[]): number | null {
  const times = tokens.map((t) => readQuote(t)?.expiresAt).filter((n): n is number => typeof n === "number");
  return times.length ? Math.min(...times) : null;
}
