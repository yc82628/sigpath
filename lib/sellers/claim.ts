/**
 * lib/sellers/claim.ts — how a seller earns the verified badge.
 *
 * Sellers are marketplace accounts, not SigPath users, so the claim has to
 * prove three separate things, each with its own evidence:
 *
 *   1. CONTROL OF THE HANDLE. SigPath gives the claimant a one-time code; they
 *      put it in the text of one of their live listings; SigPath reads that
 *      listing through the marketplace's own API. Only the account that owns
 *      a listing can edit it — and the handle is taken from the marketplace's
 *      answer, never typed by the claimant, so there is nothing to misspell or
 *      impersonate.
 *   2. CONTROL OF THE WALLET. The wallet signs a message naming the handle and
 *      the code. The token goes to that wallet and can never leave it.
 *   3. A LIVE PERSON. The same camera check as the identity flow (a handwritten
 *      code, plus fingers when issued), on its own "person" provider. Nothing
 *      biometric is kept: the frame is checked and discarded.
 *
 * And it must be ELIGIBLE: no badge already on the handle, and no active
 * upheld fake-product report against it. A penalised seller cannot buy back
 * a clean look by verifying.
 *
 * WHAT THIS DOES NOT DO — said plainly on the claim page too: it does not stop
 * a scammer opening a new account. It makes "verified" visibly different from
 * "no track record", and makes the badge cost something that a throwaway
 * account doesn't have.
 *
 * Claim state lives in two HMAC-signed tokens (like price quotes), so nothing
 * is stored until the badge is issued: a claim token (wallet + code, 48 hours
 * to edit a listing) and, once the listing checks out, a proven token (wallet +
 * handle, 30 minutes to sign and take the photo).
 */

import { createHmac, timingSafeEqual } from "crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { sellerKey as toSellerKey } from "../marketplace/types";
import type { ListingProof } from "../marketplace/sources/types";
import type { ChallengeVerification } from "../challenge/verify";
import type { Badge, VerifiedSellerLog } from "./verified-log";

export const CLAIM_TTL_SECS = 48 * 3600;
export const PROVEN_TTL_SECS = 30 * 60;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

/** Marketplaces whose API lets SigPath read a listing's seller and text. */
export const CLAIMABLE_SOURCES = ["ebay", "etsy", "stub"] as const;
export type ClaimableSource = (typeof CLAIMABLE_SOURCES)[number];

/**
 * The marketplaces a seller can verify on THIS deployment: the ones whose API
 * keys are set (and the demo, unless it's turned off). The form offers only
 * these, so nobody connects a wallet and edits a listing for a marketplace the
 * site can't read.
 */
export function claimMarketplaces(env: Record<string, string | undefined> = process.env): ClaimableSource[] {
  const has = (...keys: string[]) => keys.every((k) => !!env[k]?.trim());
  return CLAIMABLE_SOURCES.filter((s) =>
    s === "ebay" ? has("EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET") : s === "etsy" ? has("ETSY_KEYSTRING", "ETSY_SHARED_SECRET") : env.STUB_FEED !== "false",
  );
}

type Env = Record<string, string | undefined>;
type Refusal = { ok: false; status: number; error: string };

function secret(env: Env): Buffer | null {
  const s = env.QUOTE_SECRET?.trim();
  return s && s.length >= 32 ? Buffer.from(s, "utf8") : null;
}
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
// Own domain strings: a claim token can't pass as a proven token, a quote, or a seller link.
const mac = (k: Buffer, domain: string, payload: string) => createHmac("sha256", k).update(`${domain}\n`).update(payload).digest();

function sign(domain: string, body: object, env: Env): string | null {
  const k = secret(env);
  if (!k) return null;
  const payload = b64url(Buffer.from(JSON.stringify(body), "utf8"));
  return `${payload}.${b64url(mac(k, domain, payload))}`;
}

function open<T>(domain: string, token: unknown, env: Env, nowS: number): T | null {
  const k = secret(env);
  if (!k || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = mac(k, domain, payload);
  const got = fromB64url(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const body = JSON.parse(fromB64url(payload).toString("utf8")) as T & { e: number };
    return typeof body.e === "number" && nowS <= body.e ? body : null;
  } catch {
    return null;
  }
}

/** The code is derived from the token's own MAC, so it needs no storage and can't be chosen. */
function codeFrom(k: Buffer, wallet: string, issuedAt: number): string {
  const h = mac(k, "sigpath-claim-code-v1", `${wallet}|${issuedAt}`);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[h[i] % CODE_ALPHABET.length];
  return `SIGPATH-${out.slice(0, 4)}-${out.slice(4)}`;
}

interface ClaimBody {
  w: string;
  c: string;
  e: number;
}
interface ProvenBody {
  w: string;
  k: string;
  src: string;
  l: string;
  c: string;
  e: number;
}

// ---------------------------------------------------------------------------
// 1. start
// ---------------------------------------------------------------------------

export function startClaim(
  input: { wallet: unknown },
  env: Env = process.env,
  now = Date.now(),
): { ok: true; claimToken: string; code: string; expiresAt: number } | Refusal {
  const k = secret(env);
  if (!k) return { ok: false, status: 503, error: "Seller verification is not configured (QUOTE_SECRET)." };
  let wallet: string;
  try {
    wallet = new PublicKey(String(input.wallet)).toBase58();
  } catch {
    return { ok: false, status: 400, error: "Invalid wallet address." };
  }
  const issuedAt = Math.floor(now / 1000);
  const code = codeFrom(k, wallet, issuedAt);
  const expiresAt = issuedAt + CLAIM_TTL_SECS;
  return { ok: true, claimToken: sign("sigpath-claim-v1", { w: wallet, c: code, e: expiresAt } satisfies ClaimBody, env)!, code, expiresAt };
}

// ---------------------------------------------------------------------------
// 2. prove control of the handle
// ---------------------------------------------------------------------------

/** The exact text the wallet signs. Names the handle, the wallet and the code. */
export function claimMessage(sellerKey: string, wallet: string, code: string): string {
  return [
    "SigPath verified seller",
    `I control the marketplace account ${sellerKey} and claim its verified-seller badge for this wallet.`,
    `Wallet: ${wallet}`,
    `Code: ${code}`,
  ].join("\n");
}

/** Codes match ignoring case and any spacing or dashes a listing editor might add. */
export function textContainsCode(text: string, code: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return norm(text).includes(norm(code));
}

export interface ProveDeps {
  env?: Env;
  now?: number;
  /** Reads a listing through the marketplace's API. */
  lookup: (source: ClaimableSource, listingId: string) => Promise<ListingProof>;
  log: VerifiedSellerLog;
  /** Active upheld reports per sellerKey — the same map the checkout ban reads. */
  upheldCounts: () => Promise<ReadonlyMap<string, number>>;
}

async function eligibility(sellerKey: string, deps: Pick<ProveDeps, "log" | "upheldCounts">, nowS: number): Promise<Refusal | null> {
  const existing = (await deps.log.get(sellerKey))?.current;
  if (existing && !existing.revoked && nowS < existing.expiresAt) {
    return { ok: false, status: 409, error: "This account is already verified." };
  }
  if (((await deps.upheldCounts()).get(sellerKey) ?? 0) > 0) {
    return {
      ok: false,
      status: 409,
      error: "This account has an upheld fake-product report against it, so it can't be verified. If it is overturned on appeal, you can claim again.",
    };
  }
  return null;
}

export async function proveHandle(
  input: { claimToken: unknown; source: unknown; listingId: unknown },
  deps: ProveDeps,
): Promise<{ ok: true; provenToken: string; sellerKey: string; message: string } | Refusal> {
  const env = deps.env ?? process.env;
  const nowS = Math.floor((deps.now ?? Date.now()) / 1000);
  const claim = open<ClaimBody>("sigpath-claim-v1", input.claimToken, env, nowS);
  if (!claim) return { ok: false, status: 401, error: "This claim has expired or isn't valid. Start again for a new code." };

  const source = CLAIMABLE_SOURCES.find((s) => s === input.source);
  if (!source) return { ok: false, status: 400, error: "Verification isn't available for that marketplace yet." };
  if (source === "stub" && env.STUB_FEED === "false") return { ok: false, status: 400, error: "The demo marketplace is turned off." };
  const listingId = String(input.listingId ?? "").trim();
  if (!listingId || listingId.length > 200) return { ok: false, status: 400, error: "Enter the listing's item number." };

  const listing = await deps.lookup(source, listingId);
  if (!listing.ok) return { ok: false, status: 422, error: listing.error };
  if (!textContainsCode(listing.text, claim.c)) {
    return {
      ok: false,
      status: 422,
      error: `The code ${claim.c} isn't in that listing yet. Add it to the title or description, save, and check again (marketplaces can take a minute to update).`,
    };
  }

  const key = toSellerKey(source, listing.handle);
  const refusal = await eligibility(key, deps, nowS);
  if (refusal) return refusal;

  const provenToken = sign("sigpath-claim-proven-v1", { w: claim.w, k: key, src: source, l: listingId, c: claim.c, e: nowS + PROVEN_TTL_SECS } satisfies ProvenBody, env)!;
  return { ok: true, provenToken, sellerKey: key, message: claimMessage(key, claim.w, claim.c) };
}

// ---------------------------------------------------------------------------
// 3. sign, then the camera
// ---------------------------------------------------------------------------

/** Proven tokens whose wallet signature checked out, by the camera session they unlocked. In memory, like report intents. */
const SESSIONS = new Map<string, { provenToken: string; at: number }>();

export function verifyClaimSignature(
  input: { provenToken: unknown; signature: unknown },
  env: Env = process.env,
  now = Date.now(),
): { ok: true; proven: ProvenBody } | Refusal {
  const p = open<ProvenBody>("sigpath-claim-proven-v1", input.provenToken, env, Math.floor(now / 1000));
  if (!p) return { ok: false, status: 401, error: "This step has expired. Check the listing again to continue." };
  if (typeof input.signature !== "string") return { ok: false, status: 400, error: "Missing signature." };
  const sig = Buffer.from(input.signature, "base64");
  if (sig.length !== 64) return { ok: false, status: 400, error: "Malformed signature." };
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(claimMessage(p.k, p.w, p.c)), new Uint8Array(sig), new PublicKey(p.w).toBytes());
  if (!ok) return { ok: false, status: 403, error: "That signature isn't from the wallet this claim was started with." };
  return { ok: true, proven: p };
}

export function bindClaimSession(provenToken: string, sessionId: string, now = Date.now()) {
  SESSIONS.set(sessionId, { provenToken, at: now });
}

// ---------------------------------------------------------------------------
// 4. complete: check the photo, issue the badge
// ---------------------------------------------------------------------------

export interface CompleteDeps extends Pick<ProveDeps, "log" | "upheldCounts"> {
  env?: Env;
  now?: number;
  verify: (sessionId: string, payload: { imageBase64: string; mediaType: string }) => Promise<ChallengeVerification>;
  /** Issues the token on chain. Injected so tests run without a network. */
  issue: (b: { sellerKey: string; wallet: string; verifiedAt: number }) => Promise<
    { ok: true; attestation: string; mint: string; tokenAccount: string; expiresAt: number } | { ok: false; error: string }
  >;
}

export async function completeClaim(
  input: { provenToken: unknown; sessionId: unknown; imageBase64: unknown; mediaType: unknown },
  deps: CompleteDeps,
): Promise<{ ok: true; passed: true; badge: Badge; sellerKey: string } | { ok: true; passed: false; reason: string } | Refusal> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const nowS = Math.floor(now / 1000);
  const p = open<ProvenBody>("sigpath-claim-proven-v1", input.provenToken, env, nowS);
  if (!p) return { ok: false, status: 401, error: "This step has expired. Check the listing again to continue." };

  const sessionId = String(input.sessionId ?? "");
  const bound = SESSIONS.get(sessionId);
  if (!bound || bound.provenToken !== input.provenToken) {
    return { ok: false, status: 403, error: "That photo doesn't belong to this claim. Sign with your wallet to start the camera." };
  }
  if (typeof input.imageBase64 !== "string" || typeof input.mediaType !== "string") {
    return { ok: false, status: 400, error: "No photo was captured." };
  }

  // Re-checked: another tab could have claimed it, or a report been upheld, since.
  const refusal = await eligibility(p.k, deps, nowS);
  if (refusal) return refusal;

  const v = await deps.verify(sessionId, { imageBase64: input.imageBase64, mediaType: input.mediaType });
  if (v.unavailable) return { ok: false, status: 503, error: `The photo check couldn't run: ${v.unavailable}` };
  if (!v.passed) return { ok: true, passed: false, reason: v.failureReason || "The photo didn't pass the check." };
  SESSIONS.delete(sessionId);

  const issued = await deps.issue({ sellerKey: p.k, wallet: p.w, verifiedAt: nowS });
  if (!issued.ok) return { ok: false, status: 502, error: `The badge couldn't be issued: ${issued.error}` };

  const badge: Badge = {
    wallet: p.w,
    attestation: issued.attestation,
    mint: issued.mint,
    tokenAccount: issued.tokenAccount,
    proof: { source: p.src, listingId: p.l },
    verifiedAt: nowS,
    expiresAt: issued.expiresAt,
  };
  await deps.log.record(p.k, badge);
  return { ok: true, passed: true, badge, sellerKey: p.k };
}

/** Test hook. */
export function _clearClaimSessions() {
  SESSIONS.clear();
}
