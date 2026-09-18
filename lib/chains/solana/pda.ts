/**
 * lib/chains/solana/pda.ts — address derivation.
 *
 * Kept separate from the client so the browser can derive an address and check
 * whether a record exists without pulling in a signer or a provider.
 */

import { PublicKey } from "@solana/web3.js";

export const ATTEST_SEED = "attest";

/** PDA for an attestation about `subjectHash` (32 bytes). */
export function attestationPda(programId: PublicKey, subjectHash: Uint8Array): [PublicKey, number] {
  if (subjectHash.length !== 32) {
    throw new Error(`subjectHash must be 32 bytes, got ${subjectHash.length}.`);
  }
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ATTEST_SEED), Buffer.from(subjectHash)],
    programId,
  );
}
