/**
 * lib/account/session.ts — signing in with a wallet, and nothing else.
 *
 * WHY A WALLET, NOT AN ACCOUNT
 * SigPath has no shopper accounts: no email, no password, nothing to leak. A
 * shopper who paid with a wallet already has a key only they hold, so that key
 * is the login. They sign a short text (not a transaction: it costs nothing and
 * moves nothing), the server checks the ed25519 signature, and a cookie
 * remembers the wallet for 30 days. That is the whole account: the cookie holds
 * the wallet's public address and an expiry, and SigPath stores nothing.
 *
 * HOW IT IS CHECKED
 *   1. challenge(): the server writes the text to sign, naming this site, the
 *      wallet, a random nonce and the time, and returns it with a token that
 *      MACs exactly those values. Nothing is stored, so no database is needed.
 *   2. The wallet shows the text in full and signs it.
 *   3. signIn(): the token's MAC, its age (5 minutes) and its site are checked,
 *      the text is rebuilt from the token, and the signature must verify
 *      against the wallet's public key. Only then is a session cookie issued.
 *
 * The site is part of the signed text so a signature made on another site
 * can't sign in here. Both tokens are HMACs under a key derived from
 * QUOTE_SECRET with their own labels, so neither can stand in for a quote or for
 * each other.
 *
 * Pure functions, with the environment and the clock passed in: the API routes
 * and the tests call the same code.
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

export const SESSION_COOKIE = "sigpath-wallet";
export const SESSION_SECONDS = 30 * 24 * 3600;
/** How long the text to sign stays valid. */
export const CHALLENGE_SECONDS = 5 * 60;

type Env = Record<string, string | undefined>;

function baseKey(env: Env): Buffer | null {
  const s = env.QUOTE_SECRET?.trim();
  return s && s.length >= 32 ? Buffer.from(s, "utf8") : null;
}

/** A key of its own for each kind of token, derived from the one secret. */
function key(env: Env, label: "signin" | "session"): Buffer | null {
  const base = baseKey(env);
  return base ? createHmac("sha256", base).update(`sigpath-${label}-v1`).digest() : null;
}

/** Whether wallet sign-in can work on this server. */
export function signInConfigured(env: Env = process.env): boolean {
  return baseKey(env) !== null;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function seal(k: Buffer, payload: object): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64url(createHmac("sha256", k).update(body).digest())}`;
}

function open<T>(k: Buffer, token: unknown): T | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", k).update(body).digest();
  const given = fromB64url(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(fromB64url(body).toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** A wallet address in its canonical form, or null. */
export function walletAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 32 || raw.length > 44) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    return null;
  }
}

/**
 * The text the wallet shows and signs, in English and German. Wallets display
 * it in full, so it says what it is for and that it costs nothing.
 */
export function signInMessage(site: string, wallet: string, nonce: string, issuedAt: string): string {
  return [
    "SigPath sign-in",
    "",
    "Sign in to SigPath with this wallet. Free: nothing is sent or paid.",
    "Bei SigPath mit dieser Wallet anmelden. Kostenlos: Es wird nichts gesendet oder bezahlt.",
    "",
    `Site: ${site}`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
  ].join("\n");
}

interface ChallengePayload {
  /** wallet */
  w: string;
  /** site (host) */
  h: string;
  /** nonce */
  n: string;
  /** issued, ms */
  t: number;
}

export type Refusal = { ok: false; status: number; error: string };

/** A site name as the browser sent it: a host, optionally with a port. */
export function siteFrom(host: string | null | undefined): string | null {
  const h = (host ?? "").trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(h) ? h : null;
}

export function challenge(
  input: { wallet: unknown; site: string | null },
  deps: { env?: Env; now?: number } = {},
): { ok: true; message: string; token: string } | Refusal {
  const k = key(deps.env ?? process.env, "signin");
  if (!k) return { ok: false, status: 503, error: "Wallet sign-in isn't configured on this server." };
  const wallet = walletAddress(input.wallet);
  if (!wallet) return { ok: false, status: 400, error: "That isn't a Solana wallet address." };
  if (!input.site) return { ok: false, status: 400, error: "Unknown site." };
  const p: ChallengePayload = { w: wallet, h: input.site, n: randomBytes(12).toString("hex"), t: deps.now ?? Date.now() };
  return { ok: true, message: signInMessage(p.h, p.w, p.n, new Date(p.t).toISOString()), token: seal(k, p) };
}

/** Check the signed text; on success, the session cookie's value. */
export function signIn(
  input: { token: unknown; signature: unknown; site: string | null },
  deps: { env?: Env; now?: number } = {},
): { ok: true; wallet: string; session: string; maxAge: number } | Refusal {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const k = key(env, "signin");
  const sk = key(env, "session");
  if (!k || !sk) return { ok: false, status: 503, error: "Wallet sign-in isn't configured on this server." };
  const p = open<ChallengePayload>(k, input.token);
  if (!p || typeof p.w !== "string" || typeof p.h !== "string" || typeof p.n !== "string" || typeof p.t !== "number") {
    return { ok: false, status: 400, error: "This sign-in request isn't valid. Start again." };
  }
  if (now - p.t > CHALLENGE_SECONDS * 1000 || p.t - now > 60_000) {
    return { ok: false, status: 400, error: "This sign-in request has expired. Start again." };
  }
  if (!input.site || p.h !== input.site) return { ok: false, status: 400, error: "This sign-in request was made for another site." };
  if (typeof input.signature !== "string") return { ok: false, status: 400, error: "Missing signature." };
  const sig = Buffer.from(input.signature, "base64");
  if (sig.length !== 64) return { ok: false, status: 400, error: "Malformed signature." };
  const message = new TextEncoder().encode(signInMessage(p.h, p.w, p.n, new Date(p.t).toISOString()));
  const valid = nacl.sign.detached.verify(message, new Uint8Array(sig), new PublicKey(p.w).toBytes());
  if (!valid) return { ok: false, status: 403, error: "The signature doesn't match this wallet." };
  const exp = Math.floor(now / 1000) + SESSION_SECONDS;
  return { ok: true, wallet: p.w, session: seal(sk, { w: p.w, exp }), maxAge: SESSION_SECONDS };
}

/** The wallet a session cookie belongs to, while it's valid; otherwise null. */
export function sessionWallet(cookie: string | undefined | null, deps: { env?: Env; now?: number } = {}): string | null {
  const sk = key(deps.env ?? process.env, "session");
  if (!sk || !cookie) return null;
  const p = open<{ w: string; exp: number }>(sk, cookie);
  if (!p || typeof p.exp !== "number" || p.exp * 1000 <= (deps.now ?? Date.now())) return null;
  return walletAddress(p.w);
}

/** The cookie's attributes: only this site's server can read it, only over HTTPS in production. */
export function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
