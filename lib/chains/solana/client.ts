/**
 * lib/chains/solana/client.ts — reading attestations from Solana.
 *
 * READ PATH ONLY, AND DELIBERATELY SO.
 * Anyone can verify an attestation: it is a public account, and checking it
 * needs no key, no wallet and no server. Writing is a separate concern that
 * belongs behind an API route with the issuer's signer — never in the browser.
 *
 * The account is decoded by hand rather than through the Anchor IDL so this
 * module works before the program is deployed and without generating types.
 * If you later want the typed client, swap in `@coral-xyz/anchor`'s Program —
 * the layout below is the contract either way.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { SOLANA_PROGRAM_ID, SOLANA_RPC_URL } from "../../config";
import { attestationPda } from "./pda";
import { bytesToHex } from "../../crypto/hash";

export interface Attestation {
  subjectHash: string;
  issuer: string;
  score: number;
  method: number;
  /** EAS UID on Base, or null when not mirrored. */
  baseUid: string | null;
  issuedAt: number;
  /** null = never expires. */
  expiresAt: number | null;
  revoked: boolean;
}

/**
 * Four outcomes, not two. "No record" and "revoked" and "expired" are different
 * facts about a subject and a UI must be able to tell them apart — collapsing
 * them into a boolean is how a revoked attestation ends up looking merely
 * unknown.
 */
export type VerifyResult =
  | { status: "verified"; attestation: Attestation }
  | { status: "revoked"; attestation: Attestation }
  | { status: "expired"; attestation: Attestation }
  | { status: "not_found" };

export function connection(): Connection {
  return new Connection(SOLANA_RPC_URL, "confirmed");
}

function programId(): PublicKey {
  if (!SOLANA_PROGRAM_ID) {
    throw new Error("NEXT_PUBLIC_PROGRAM_ID is not set — deploy the program first.");
  }
  return new PublicKey(SOLANA_PROGRAM_ID);
}

/**
 * Decode the Attestation account.
 *
 * Layout must match programs/sigpath/src/lib.rs exactly. Anchor prefixes every
 * account with an 8-byte discriminator, which is why offsets start at 8.
 */
function decode(data: Buffer): Attestation {
  let o = 8;
  const take = (n: number) => {
    const slice = data.subarray(o, o + n);
    o += n;
    return slice;
  };

  const subjectHash = bytesToHex(new Uint8Array(take(32)));
  const issuer = new PublicKey(take(32)).toBase58();
  const score = take(1)[0];
  const method = take(1)[0];
  const baseUidBytes = new Uint8Array(take(32));
  const issuedAt = Number(data.readBigInt64LE(o));
  o += 8;
  const expiresAt = Number(data.readBigInt64LE(o));
  o += 8;
  const revoked = take(1)[0] === 1;

  // An all-zero UID means "not mirrored to Base", not "mirrored to 0x000…".
  const allZero = baseUidBytes.every((b) => b === 0);

  return {
    subjectHash,
    issuer,
    score,
    method,
    baseUid: allZero ? null : bytesToHex(baseUidBytes),
    issuedAt,
    expiresAt: expiresAt === 0 ? null : expiresAt,
    revoked,
  };
}

/** Look up an attestation by its subject hash. */
export async function verifySubject(
  subjectHash: Uint8Array,
  conn: Connection = connection(),
): Promise<VerifyResult> {
  const [pda] = attestationPda(programId(), subjectHash);
  const info = await conn.getAccountInfo(pda);
  if (!info) return { status: "not_found" };

  const attestation = decode(info.data);

  if (attestation.revoked) return { status: "revoked", attestation };

  const now = Math.floor(Date.now() / 1000);
  if (attestation.expiresAt !== null && now > attestation.expiresAt) {
    return { status: "expired", attestation };
  }

  return { status: "verified", attestation };
}

/** Method bitfield — must match the constants in lib.rs. */
export const METHOD = {
  SELF_ASSERTED: 1 << 0,
  OWNERSHIP_PROVEN: 1 << 1,
  CORROBORATED: 1 << 2,
  LIVE_CAPTURE: 1 << 3,
} as const;

export function hasMethod(attestation: Attestation, flag: number): boolean {
  return (attestation.method & flag) !== 0;
}

/** Human-readable list of how the score was reached. */
export function describeMethods(attestation: Attestation): string[] {
  const out: string[] = [];
  if (hasMethod(attestation, METHOD.SELF_ASSERTED)) out.push("self-asserted");
  if (hasMethod(attestation, METHOD.OWNERSHIP_PROVEN)) out.push("account control proven");
  if (hasMethod(attestation, METHOD.CORROBORATED)) out.push("corroborated by third parties");
  if (hasMethod(attestation, METHOD.LIVE_CAPTURE)) out.push("live capture verified");
  return out;
}
