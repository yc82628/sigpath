/**
 * lib/chains/solana/instructions.ts — hand-built Anchor instructions.
 *
 * WHY THIS FILE EXISTS
 * IDL generation is disabled on this toolchain (see README, toolchain trap #3),
 * so there is no typed `@coral-xyz/anchor` client. Instructions are assembled
 * here by hand: an 8-byte discriminator followed by Borsh-encoded arguments.
 *
 * THE DANGER, STATED PLAINLY
 * Nothing checks this file against the program. If a field is added, reordered
 * or resized in programs/sigpath/src/lib.rs and not mirrored here, the encoding
 * silently becomes wrong — the transaction either fails with an opaque error or,
 * worse, succeeds and writes garbage. There is no compiler and no type system
 * spanning that boundary; the only guard is the round-trip test in
 * tests/instructions.test.ts. Run it after any change to the program.
 *
 * ARGUMENT ORDER MUST MATCH THE RUST SIGNATURE EXACTLY.
 *   issue(subject_hash, score, method, base_uid, ttl_seconds)
 *   revoke(subject_hash)
 *   link_base(subject_hash, base_uid)
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { attestationPda } from "./pda";

/**
 * Anchor's instruction discriminator: the first 8 bytes of
 * sha256("global:<snake_case_method_name>").
 *
 * The "global:" prefix is Anchor's namespace for top-level program methods —
 * it is not decorative, and getting it wrong produces an 8-byte prefix that
 * matches no instruction, which the program rejects as unknown.
 */
export function discriminator(methodName: string): Buffer {
  return createHash("sha256").update(`global:${methodName}`).digest().subarray(0, 8);
}

// ---------------------------------------------------------------------------
// Borsh primitives
//
// Only the types this program actually uses. Borsh is little-endian for all
// integers, and fixed-size arrays are written raw with no length prefix —
// which is why a [u8; 32] is just 32 bytes, unlike a Vec<u8>.
// ---------------------------------------------------------------------------

function u8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`u8 out of range: ${value}`);
  }
  return Buffer.from([value]);
}

function i64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(value));
  return buf;
}

function fixed32(bytes: Uint8Array): Buffer {
  if (bytes.length !== 32) {
    throw new Error(`expected 32 bytes, got ${bytes.length}`);
  }
  return Buffer.from(bytes);
}

/** All-zero base_uid means "not mirrored to Base". */
export const NO_BASE_UID = new Uint8Array(32);

// ---------------------------------------------------------------------------
// Method bitfield — must match the METHOD_* constants in lib.rs
// ---------------------------------------------------------------------------

export const METHOD = {
  SELF_ASSERTED: 1 << 0,
  OWNERSHIP_PROVEN: 1 << 1,
  CORROBORATED: 1 << 2,
  LIVE_CAPTURE: 1 << 3,
} as const;

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export interface IssueArgs {
  programId: PublicKey;
  issuer: PublicKey;
  subjectHash: Uint8Array;
  /** 0..100. The program rejects anything above 100. */
  score: number;
  /** Bitwise OR of METHOD values. */
  method: number;
  baseUid?: Uint8Array;
  /** 0 = never expires. */
  ttlSeconds: number;
}

export function issueIx(args: IssueArgs): TransactionInstruction {
  const { programId, issuer, subjectHash, score, method, ttlSeconds } = args;

  // Fail here rather than paying for a transaction the program will reject.
  if (score < 0 || score > 100) throw new Error(`score must be 0..100, got ${score}`);

  const [attestation] = attestationPda(programId, subjectHash);

  const data = Buffer.concat([
    discriminator("issue"),
    fixed32(subjectHash),
    u8(score),
    u8(method),
    fixed32(args.baseUid ?? NO_BASE_UID),
    i64(ttlSeconds),
  ]);

  // Account order must match the Issue<'info> struct in lib.rs, in declaration
  // order. Anchor matches positionally, not by name.
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: attestation, isSigner: false, isWritable: true },
      { pubkey: issuer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function revokeIx(
  programId: PublicKey,
  issuer: PublicKey,
  subjectHash: Uint8Array,
): TransactionInstruction {
  const [attestation] = attestationPda(programId, subjectHash);

  const data = Buffer.concat([discriminator("revoke"), fixed32(subjectHash)]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: attestation, isSigner: false, isWritable: true },
      { pubkey: issuer, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export function linkBaseIx(
  programId: PublicKey,
  issuer: PublicKey,
  subjectHash: Uint8Array,
  baseUid: Uint8Array,
): TransactionInstruction {
  const [attestation] = attestationPda(programId, subjectHash);

  const data = Buffer.concat([
    discriminator("link_base"),
    fixed32(subjectHash),
    fixed32(baseUid),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: attestation, isSigner: false, isWritable: true },
      { pubkey: issuer, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Byte layout of the encoded `issue` arguments, exported so the test can assert
 * against it rather than re-deriving the same (possibly wrong) numbers.
 */
export const ISSUE_LAYOUT = {
  discriminator: { offset: 0, size: 8 },
  subjectHash: { offset: 8, size: 32 },
  score: { offset: 40, size: 1 },
  method: { offset: 41, size: 1 },
  baseUid: { offset: 42, size: 32 },
  ttlSeconds: { offset: 74, size: 8 },
  total: 82,
} as const;
