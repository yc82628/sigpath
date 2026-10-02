/**
 * lib/marketplace/ebay-deletion.ts — eBay Marketplace Account Deletion.
 *
 * WHY THIS EXISTS
 * eBay keeps a production keyset DISABLED until the app either subscribes to
 * account-deletion notifications or declares it stores no eBay user data.
 * SigPath does store eBay usernames — the seller of each order it places (kept
 * for the 30-day report window), sellers' replies and appeals, report
 * decisions, verified-seller badges — so the honest route is the subscription:
 * when an eBay user deletes their account, eBay tells SigPath, and SigPath
 * removes what it holds about them.
 *
 * THE PROTOCOL
 *   GET  ?challenge_code=…  ->  { challengeResponse: hex(sha256(code + token + endpoint)) }
 *        proves to eBay that this endpoint is ours (token chosen by us, entered
 *        in eBay's developer portal; endpoint = the exact URL registered there)
 *   POST a notification, signed: X-EBAY-SIGNATURE is base64 JSON
 *        { alg: "ECDSA", kid, signature, digest: "SHA1" }; the key comes from
 *        eBay's Notification API by kid. An unverifiable notice is refused
 *        (412) and nothing is deleted — otherwise anyone could POST a username
 *        and wipe a seller's record.
 *
 * WHAT "DELETE" MEANS HERE (see purgeEbayUser)
 *   - order records naming the seller: deleted
 *   - pending reports about them: deleted (there is no one left to answer)
 *   - their side of each case — the notice, their reply and appeal, which are
 *     their own words: deleted
 *   - report decisions: the handle replaced by a one-way pseudonym; the
 *     decision itself (category, dates, the evidence hash) stays, because it
 *     records what SigPath did and contains nothing else about them
 *   - a verified-seller badge: burned on chain (best effort) and its record
 *     deleted
 * ON CHAIN: report attestations name the seller only by subjectHash (a hash of
 * "ebay:handle"), never the handle, and cannot be erased by anyone. A badge's
 * token metadata held a link with the handle in it, which is why the badge is
 * burned — and why new badges link to the claim page, not the seller's page.
 */

import { createHash, createPublicKey, verify } from "crypto";
import { sellerKey } from "./types";
import type { OrderMetaStore } from "../reports/order-meta";
import type { ReportStore, DecisionLog } from "../reports/reports";
import type { CaseLog } from "../reports/cases";
import type { VerifiedSellerLog } from "../sellers/verified-log";

type Env = Record<string, string | undefined>;

export const DELETION_TOPIC = "MARKETPLACE_ACCOUNT_DELETION";

/** eBay's rule for the verification token: 32 to 80 characters, alphanumerics, underscore and hyphen. */
export function deletionConfig(env: Env = process.env): { token: string; endpoint: string } | null {
  const token = env.EBAY_VERIFICATION_TOKEN?.trim() ?? "";
  const endpoint = env.EBAY_DELETION_ENDPOINT?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{32,80}$/.test(token)) return null;
  try {
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { token, endpoint };
}

/** The challenge answer: hex SHA-256 of code, token and endpoint, concatenated in that order. */
export function challengeResponse(challengeCode: string, token: string, endpoint: string): string {
  return createHash("sha256").update(challengeCode).update(token).update(endpoint).digest("hex");
}

export interface DeletionNotice {
  notificationId: string;
  username: string;
  userId?: string;
}

/** A deletion notice, or null for anything else (another topic, or not eBay's shape). */
export function parseNotice(body: unknown): DeletionNotice | null {
  const b = body as {
    metadata?: { topic?: unknown };
    notification?: { notificationId?: unknown; data?: { username?: unknown; userId?: unknown } };
  } | null;
  if (b?.metadata?.topic !== DELETION_TOPIC) return null;
  const n = b.notification;
  if (typeof n?.notificationId !== "string" || typeof n.data?.username !== "string" || !n.data.username.trim()) return null;
  return {
    notificationId: n.notificationId,
    username: n.data.username.trim(),
    userId: typeof n.data.userId === "string" ? n.data.userId : undefined,
  };
}

/** eBay serves the key with or without PEM armour; normalise it. */
function toPem(key: string): string {
  if (key.includes("BEGIN PUBLIC KEY")) {
    const body = key.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
    return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
  }
  return `-----BEGIN PUBLIC KEY-----\n${key.replace(/\s+/g, "").match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Check X-EBAY-SIGNATURE over the RAW request body. Any doubt — a missing or
 * malformed header, an unknown key, a bad signature — is a refusal.
 */
export async function verifyEbaySignature(
  rawBody: string,
  header: string | null,
  getKey: (kid: string) => Promise<string | null>,
): Promise<boolean> {
  if (!header) return false;
  let sig: { alg?: unknown; kid?: unknown; signature?: unknown; digest?: unknown };
  try {
    sig = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return false;
  }
  if (sig.alg !== "ECDSA" || typeof sig.kid !== "string" || typeof sig.signature !== "string") return false;
  const digest = typeof sig.digest === "string" ? sig.digest.toLowerCase() : "sha1";
  if (digest !== "sha1" && digest !== "sha256") return false;
  const key = await getKey(sig.kid);
  if (!key) return false;
  try {
    return verify(digest, Buffer.from(rawBody, "utf8"), { key: createPublicKey(toPem(key)), dsaEncoding: "der" }, Buffer.from(sig.signature, "base64"));
  } catch {
    return false;
  }
}

export interface PurgeReport {
  orderRecords: number;
  pendingReports: number;
  cases: number;
  decisions: number;
  badge: "none" | "burned" | "record deleted, burn failed";
}

/** Stable, one-way stand-in for a deleted handle in the decision log. */
export function deletedPseudonym(key: string): string {
  return `ebay:deleted-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** Remove what SigPath holds about one eBay user. Idempotent: eBay retries, and a second run finds nothing. */
export async function purgeEbayUser(
  username: string,
  deps: {
    metaStore: OrderMetaStore | null;
    reportStore: ReportStore | null;
    decisions: DecisionLog;
    cases: CaseLog;
    verified: VerifiedSellerLog;
    /** Burns the badge on chain. Optional: without it the record is still deleted. */
    revokeBadge?: (sellerKey: string, reason: string) => Promise<{ revoked: boolean; chainError?: string }>;
  },
): Promise<PurgeReport> {
  const key = sellerKey("ebay", username);
  const mine = (s: { source: string; handle: string }) => sellerKey(s.source, s.handle) === key;
  const report: PurgeReport = { orderRecords: 0, pendingReports: 0, cases: 0, decisions: 0, badge: "none" };

  if (deps.metaStore) {
    for (const { order } of await deps.metaStore.list()) {
      const got = await deps.metaStore.get(order).catch(() => null);
      if (got && mine(got.record.seller) && (await deps.metaStore.delete(order))) report.orderRecords++;
    }
  }
  if (deps.reportStore) {
    for (const { order } of await deps.reportStore.list()) {
      const got = await deps.reportStore.get(order).catch(() => null);
      if (got && mine(got.record.seller) && (await deps.reportStore.delete(order))) report.pendingReports++;
    }
  }
  report.cases = await deps.cases.removeSeller(key);
  report.decisions = await deps.decisions.renameSeller(key, deletedPseudonym(key));

  const badge = await deps.verified.get(key);
  if (badge) {
    // Already burned only if a revocation reached the chain; a recorded burn
    // failure is retried here like any live badge.
    let burned = !!badge.current.revoked && !badge.current.revoked.chainError;
    if (!burned && deps.revokeBadge) {
      const r = await deps.revokeBadge(key, "eBay account deleted").catch(() => ({ revoked: false, chainError: "error" }));
      burned = r.revoked && !r.chainError;
    }
    await deps.verified.remove(key);
    report.badge = burned ? "burned" : "record deleted, burn failed";
  }
  return report;
}
