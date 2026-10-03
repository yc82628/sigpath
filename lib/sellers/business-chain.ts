/**
 * lib/sellers/business-chain.ts — keeping a business's Solana record in step.
 *
 * Publishes the attestation when a business becomes (or stays) verified with
 * new details, and closes it when the business is suspended. A chain failure
 * never undoes a verification or a suspension: SigPath's record decides what
 * is shown, the failure is written down, and the admin script retries.
 */

import { sasConfigFromEnv, type SasConfig } from "../chains/solana/sas";
import { issueBusinessAttestation, revokeBusinessAttestation } from "../chains/solana/sas-business";
import type { Business, BusinessLog, BusinessView } from "./business";
import type { VerifiedSellerLog } from "./verified-log";

export type PublishBusiness = (b: Business, v: BusinessView) => Promise<NonNullable<Business["onChain"]>>;

/** Undefined when no chain is configured: businesses are then verified off-chain only. */
export function businessPublisher(cfg: SasConfig | null = sasConfigFromEnv()): PublishBusiness | undefined {
  if (!cfg) return undefined;
  return async (b, v) => {
    const publishedAt = Math.floor(Date.now() / 1000);
    if (!b.vat || !v.expiresAt) return { attestation: "", publishedAt, error: "Not verified: nothing to publish." };
    const r = await issueBusinessAttestation(cfg, {
      wallet: b.wallet,
      country: b.vat.country,
      vatNumber: b.vat.number,
      domain: b.domain?.name,
      linkedAccounts: v.accounts.filter((a) => a.active).length,
      verifiedAt: b.vat.checkedAt,
      expiresAt: v.expiresAt,
    });
    return r.status === "ok"
      ? { attestation: r.attestation, signature: r.signature, publishedAt }
      : { attestation: b.onChain?.attestation ?? "", publishedAt, error: r.status === "error" ? r.reason : "already exists" };
  };
}

/**
 * Close the attestation of the business whose wallet holds this seller's badge.
 * Used when a report against the seller is upheld. Null when the seller is
 * not part of a recorded business.
 */
export function businessRevoker(log: BusinessLog, badges: VerifiedSellerLog, cfg: SasConfig | null = sasConfigFromEnv()) {
  return async (sellerKey: string): Promise<{ wallet: string; signature?: string; chainError?: string } | null> => {
    const wallet = (await badges.get(sellerKey))?.current.wallet;
    const business = wallet ? await log.byWallet(wallet) : null;
    if (!wallet || !business?.onChain?.attestation || business.onChain.revokedAt) return null;
    if (!cfg) return { wallet, chainError: "No chain configured." };
    const r = await revokeBusinessAttestation(cfg, wallet);
    const revokedAt = Math.floor(Date.now() / 1000);
    if (r.status === "error") return { wallet, chainError: r.reason };
    const signature = r.status === "ok" ? r.signature : undefined;
    await log.update(wallet, (b) => ({ ...b, onChain: { ...b.onChain!, revokedAt, revokeSignature: signature } }));
    return { wallet, signature };
  };
}
