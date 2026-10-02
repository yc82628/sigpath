/**
 * lib/sellers/verified-log.ts — SigPath's copy of who holds a verified badge.
 *
 * The chain is the record anyone can check (sas-verified.ts). This log exists
 * so the search page can show badges without an RPC call per listing, and so
 * a revocation is remembered even if the chain call to burn the token failed.
 *
 * It holds nothing personal beyond what the seller published by opting in:
 * their handle, the wallet that holds the token (visible on chain anyway) and
 * the listing they proved control with. Written atomically, like the decision
 * log; a revoked badge is kept in `history`, never erased.
 */

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

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
  constructor(private readonly file: string) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): VerifiedSellerLog {
    return new VerifiedSellerLog(env.VERIFIED_SELLERS_FILE?.trim() || join(process.cwd(), ".data", "sellers", "verified.json"));
  }

  async all(): Promise<Record<string, BadgeEntry>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  async get(sellerKey: string): Promise<BadgeEntry | null> {
    return (await this.all())[sellerKey] ?? null;
  }

  private async write(all: Record<string, BadgeEntry>) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Record a newly issued badge. A previous, revoked one moves to history. */
  async record(sellerKey: string, badge: Badge): Promise<void> {
    const all = await this.all();
    const prev = all[sellerKey];
    if (prev && !prev.current.revoked) throw new Error("This handle already holds a verified badge.");
    all[sellerKey] = { current: badge, history: prev ? [...prev.history, prev.current] : [] };
    await this.write(all);
  }

  async markRevoked(sellerKey: string, revoked: NonNullable<Badge["revoked"]>): Promise<Badge> {
    const all = await this.all();
    const e = all[sellerKey];
    if (!e) throw new Error("No badge for that seller.");
    if (e.current.revoked && !e.current.revoked.chainError) throw new Error("That badge has already been revoked.");
    e.current.revoked = revoked;
    await this.write(all);
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
