/**
 * lib/reports/publish.ts — put an upheld report on chain.
 *
 * Kept apart from reports.ts so the review logic can be tested without a
 * network, and apart from the admin script so an end-to-end run exercises the
 * exact code the reviewer runs.
 */

import { subjectHash } from "../crypto/hash";
import { signer, sasConfigFromEnv, type SasConfig } from "../chains/solana/sas";
import {
  bootstrapReportSchema,
  bootstrapReversalSchema,
  countSellerReportsOnChain,
  issueReportAttestation,
  issueReversalAttestation,
} from "../chains/solana/sas-reports";
import { listingHashHex, type Decision, type ReportRecord } from "./reports";

/** Publish the reversal of an upheld finding, at the same index as the finding. */
export function reversalPublisher(cfg: SasConfig | null = sasConfigFromEnv()) {
  return async (d: Decision, reversedAt: number): Promise<{ attestation: string } | { error: string }> => {
    if (!cfg) return { error: "SAS is not configured (SAS_ENABLED=true and ISSUER_SECRET)." };
    if (d.index === undefined || !d.attestation) {
      return { error: "This finding was never published on chain, so there is nothing on chain to reverse." };
    }
    const boot = await bootstrapReversalSchema(cfg);
    if (boot.status === "error" || boot.status === "disabled") return { error: boot.reason };

    // sellerKey is "source:handle", canonicalised the way subjectHash is.
    const sep = d.sellerKey.indexOf(":");
    const sellerSubject = await subjectHash(d.sellerKey.slice(0, sep), d.sellerKey.slice(sep + 1));
    const res = await issueReversalAttestation(cfg, { sellerSubject, index: d.index, reversedAt });
    if (res.status !== "ok") return { error: "reason" in res ? res.reason : res.status };
    return { attestation: res.attestation };
  };
}

export function reportPublisher(cfg: SasConfig | null = sasConfigFromEnv()) {
  return async (
    r: ReportRecord,
    _localIndex: number,
    upheldAt: number,
  ): Promise<{ attestation: string; index: number } | { error: string }> => {
    if (!cfg) return { error: "SAS is not configured (SAS_ENABLED=true and ISSUER_SECRET)." };

    const boot = await bootstrapReportSchema(cfg);
    if (boot.status === "error" || boot.status === "disabled") return { error: boot.reason };

    const sellerSubject = await subjectHash(r.seller.source, r.seller.handle);
    const authority = await signer(cfg);
    // The chain decides the index — see the publish contract in reports.ts.
    const index = await countSellerReportsOnChain(authority.address, sellerSubject, cfg.rpcUrl);

    const res = await issueReportAttestation(cfg, {
      sellerSubject,
      index,
      category: r.category,
      upheldAt,
      evidenceSha256: r.evidence.sha256,
      listingHash: listingHashHex(r.listing),
    });
    if (res.status !== "ok") return { error: "reason" in res ? res.reason : res.status };
    return { attestation: res.attestation, index };
  };
}
