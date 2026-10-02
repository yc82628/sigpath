/**
 * lib/sellers/badges.ts — the verified-seller pieces wired to the real world:
 * marketplace APIs, the chain, the vision check. Routes and scripts import
 * from here; claim.ts and verified-log.ts stay pure and testable.
 */

import { EbaySource } from "../marketplace/sources/ebay";
import { EtsySource } from "../marketplace/sources/etsy";
import type { ListingProof } from "../marketplace/sources/types";
import { VisionLivenessProvider } from "../liveness/vision";
import { subjectHash } from "../crypto/hash";
import { sasConfigFromEnv, type SasConfig } from "../chains/solana/sas";
import { issueVerifiedBadge, revokeVerifiedBadge } from "../chains/solana/sas-verified";
import type { ClaimableSource } from "./claim";
import type { VerifiedSellerLog } from "./verified-log";

type Env = Record<string, string | undefined>;

/** "ebay:some_user" -> its subject hash. Etsy handles contain a colon ("shop:123"), so split at the FIRST one. */
export function sellerSubject(sellerKey: string): Promise<Uint8Array> {
  const i = sellerKey.indexOf(":");
  return subjectHash(sellerKey.slice(0, i), sellerKey.slice(i + 1));
}

/**
 * The demo marketplace has no real listings to edit, so a "listing id" of the
 * form `<handle>:<listing text>` stands for a listing by <handle> whose text
 * is <listing text>. It is the stub feed's stand-in for eBay's API — off
 * whenever STUB_FEED=false, and never able to produce an eBay or Etsy handle.
 */
export function stubListingForProof(listingId: string): ListingProof {
  const i = listingId.indexOf(":");
  if (i <= 0) return { ok: false, error: "Demo listings are written as handle:listing text, e.g. my_shop:Genuine boots SIGPATH-ABCD-EFGH" };
  return { ok: true, handle: listingId.slice(0, i).trim(), text: listingId.slice(i + 1) };
}

export function listingLookup(env: Env = process.env) {
  return async (source: ClaimableSource, listingId: string): Promise<ListingProof> => {
    if (source === "ebay") return new EbaySource(env).listingForProof(listingId);
    if (source === "etsy") return new EtsySource(env).listingForProof(listingId);
    return stubListingForProof(listingId);
  };
}

let provider: VisionLivenessProvider | null = null;
/** Always the vision provider, never the mock — a badge nobody checked is worse than none. */
export function claimProvider(): VisionLivenessProvider {
  provider ??= new VisionLivenessProvider("person");
  return provider;
}

export function badgeIssuer(cfg: SasConfig | null = sasConfigFromEnv(), baseUrl = process.env.PUBLIC_BASE_URL ?? "https://sigpath.example") {
  return async (b: { sellerKey: string; wallet: string; verifiedAt: number }) => {
    if (!cfg) return { ok: false as const, error: "SAS is not configured (SAS_ENABLED=true and ISSUER_SECRET)." };
    const i = b.sellerKey.indexOf(":");
    const res = await issueVerifiedBadge(cfg, {
      sellerSubject: await sellerSubject(b.sellerKey),
      wallet: b.wallet,
      verifiedAt: b.verifiedAt,
      uri: `${baseUrl.replace(/\/+$/, "")}/seller/${b.sellerKey.slice(0, i)}/${encodeURIComponent(b.sellerKey.slice(i + 1))}`,
    });
    if (res.status !== "ok") return { ok: false as const, error: res.reason };
    return { ok: true as const, attestation: res.attestation, mint: res.mint, tokenAccount: res.tokenAccount, expiresAt: res.expiresAt };
  };
}

/**
 * Revoke a seller's badge: burn the token on chain, then record it. If the
 * burn fails the revocation is still recorded (with the error), because the
 * badge must stop showing NOW — badgeFor() also hides it on any upheld report —
 * and the chain side can be retried with `reports-admin revoke-badge`.
 */
export function badgeRevoker(log: VerifiedSellerLog, cfg: SasConfig | null = sasConfigFromEnv()) {
  return async (sellerKey: string, reason: string): Promise<{ revoked: boolean; signature?: string; chainError?: string }> => {
    const e = await log.get(sellerKey);
    if (!e || (e.current.revoked && !e.current.revoked.chainError)) return { revoked: false };
    const at = Math.floor(Date.now() / 1000);
    const res = cfg ? await revokeVerifiedBadge(cfg, await sellerSubject(sellerKey)) : null;
    if (res?.status === "ok") {
      await log.markRevoked(sellerKey, { at, reason, signature: res.signature });
      return { revoked: true, signature: res.signature };
    }
    const chainError = !res ? "SAS is not configured" : "reason" in res ? res.reason : res.status;
    await log.markRevoked(sellerKey, { at, reason, chainError });
    return { revoked: true, chainError };
  };
}
