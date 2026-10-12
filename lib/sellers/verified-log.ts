/**
 * lib/sellers/verified-log.ts — SigPath's copy of who holds a verified badge.
 *
 * The chain is the record anyone can check (sas-verified.ts). This log exists
 * so the search page can show badges without an RPC call per listing, and so
 * a revocation is remembered even if the chain call to burn the token failed.
 *
 * It holds nothing personal beyond what the seller published by opting in:
 * their handle, the wallet that holds the token (visible on chain anyway) and
 * the listing they proved control with. Kept like the decision log (the shared
 * database, else a JSON file); a revoked badge is kept in `history`, never erased.
 */

import { join } from "path";
import { dataDir } from "../data-dir";
import { asTable, tableFromEnv, type Table } from "../kv/table";

export interface Badge {
  wallet: string;
  attestation: string;
  mint: string;
  tokenAccount: string;
  /** The listing whose text carried the claim code — the proof of control. */
  proof: { source: string; listingId: string };
  verifiedAt: number;
  expiresAt: number;
  revoked?: {
    at: number;
    reason: string;
    /** Set when the token was burned on chain. */
    signature?: string;
    /** Set when burning failed. SigPath already hides the badge; retry with reports-admin revoke-badge. */
    chainError?: string;
  };
}

export interface BadgeEntry {
  current: Badge;
  history: Badge[];
}

export class VerifiedSellerLog {
  private readonly table: Table<BadgeEntry>;

  constructor(table: Table<BadgeEntry> | string) {
    this.table = asTable(table);
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): VerifiedSellerLog {
    return new VerifiedSellerLog(
      tableFromEnv(env, {
        explicitFile: env.VERIFIED_SELLERS_FILE,
        defaultFile: join(dataDir(env), "sellers", "verified.json"),
        name: "verified-sellers",
      }),
    );
  }

  async all(): Promise<Record<string, BadgeEntry>> {
    return this.table.all();
  }

  async get(sellerKey: string): Promise<BadgeEntry | null> {
    return this.table.get(sellerKey);
  }

  /** Record a newly issued badge. A previous, revoked one moves to history. */
  async record(sellerKey: string, badge: Badge): Promise<void> {
    const prev = await this.table.get(sellerKey);
    if (prev && !prev.current.revoked) throw new Error("This handle already holds a verified badge.");
    if (!prev) {
      // Two claims for one handle at once: only the first is recorded.
      if (!(await this.table.setIfAbsent(sellerKey, { current: badge, history: [] }))) {
        throw new Error("This handle already holds a verified badge.");
      }
      return;
    }
    await this.table.set(sellerKey, { current: badge, history: [...prev.history, prev.current] });
  }

  /** Delete a seller's badge record, history included — for an account deleted at the marketplace. */
  async remove(sellerKey: string): Promise<boolean> {
    return (await this.table.delete(sellerKey)) > 0;
  }

  async markRevoked(sellerKey: string, revoked: NonNullable<Badge["revoked"]>): Promise<Badge> {
    const e = await this.table.get(sellerKey);
    if (!e) throw new Error("No badge for that seller.");
    if (e.current.revoked && !e.current.revoked.chainError) throw new Error("That badge has already been revoked.");
    e.current.revoked = revoked;
    await this.table.set(sellerKey, e);
    return e.current;
  }
}

export interface BadgeView {
  attestation: string;
  verifiedAt: number;
  expiresAt: number;
}

/**
 * Whether to SHOW a badge. Three conditions, each enough to hide it: revoked,
 * lapsed, or any active upheld report against the handle — the last one
 * independently of whether revocation reached the chain, so a failed burn can
 * never leave a "verified" badge beside a seller SigPath has penalised.
 */
export function badgeFor(
  sellerKey: string,
  entries: Record<string, BadgeEntry>,
  upheld: ReadonlyMap<string, number>,
  nowS = Math.floor(Date.now() / 1000),
): BadgeView | null {
  const b = entries[sellerKey]?.current;
  if (!b || b.revoked || nowS >= b.expiresAt || (upheld.get(sellerKey) ?? 0) > 0) return null;
  return { attestation: b.attestation, verifiedAt: b.verifiedAt, expiresAt: b.expiresAt };
}
