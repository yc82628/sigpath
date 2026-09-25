/**
 * lib/chains/solana/spl.ts — the few SPL Token operations the checkout needs,
 * hand-built.
 *
 * Why not @solana/spl-token? Three instructions do not justify a dependency
 * whose major versions track a different web3.js than the one this project
 * pins, and the on-chain program already hand-builds its token CPIs for the
 * same reason (see programs/sigpath_orders/Cargo.toml). Every index and byte
 * layout here is from the SPL Token and Associated Token Account programs and
 * is exercised end to end by scripts/orders-roundtrip.ts.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** The standard (associated) token account for `owner` and `mint`. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Create the associated token account if it does not exist; do nothing if it
 * does. Idempotent (ATA instruction 1), so it is always safe to prepend.
 */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** TransferChecked = 12: [12, amount u64 LE, decimals]. */
export function transferCheckedIx(args: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(args.amount, 1);
  data.writeUInt8(args.decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** MintTo = 7: [7, amount u64 LE]. Local-validator tests only — needs the mint authority. */
export function mintToIx(args: {
  mint: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(args.amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.mint, isSigner: false, isWritable: true },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Token balance from raw account data (amount at bytes 64..72), or null if the
 * account does not exist. Raw base units — 1 USDC is 1_000_000.
 */
export function tokenAmountFromData(data: Buffer | Uint8Array | null | undefined): bigint | null {
  if (!data || data.length < 72) return null;
  return Buffer.from(data).readBigUInt64LE(64);
}
