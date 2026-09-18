/**
 * lib/chains/base/attest.ts — the Base (EAS) mirror.
 *
 * WHY BASE IS A MIRROR, NOT A SECOND SOURCE OF TRUTH
 * Two chains that can both originate an attestation gives you two answers and
 * no way to reconcile them. So Solana originates, Base mirrors. If the mirror
 * disagrees with Solana, Solana wins — and the UI should say the mirror is
 * stale rather than showing a conflict.
 *
 * WHY IT IS OFF BY DEFAULT
 * The mirror costs an EVM transaction and an EVM key. Nothing in the core flow
 * may block on it: issue on Solana, mirror asynchronously, call `link_base`
 * when it confirms. Every function here degrades to a clear "disabled" result
 * rather than throwing, so a missing Base config can never break verification.
 *
 * SERVER ONLY. BASE_ATTESTER_SECRET is an EVM private key — it must never reach
 * the browser. Nothing in this file may be imported from a client component.
 */

import { EAS, SchemaEncoder } from "@ethereum-attestation-service/eas-sdk";
import { ethers } from "ethers";
import {
  BASE_ENABLED,
  BASE_RPC_URL,
  EAS_CONTRACT_ADDRESS,
  EAS_EXPLORER,
  EAS_SCHEMA_UID,
} from "../../config";

/**
 * The EAS schema this app writes. Register it once (see README) and put the
 * resulting UID in EAS_SCHEMA_UID.
 *
 *   bytes32 subjectHash, uint8 score, uint8 method, uint64 issuedAt
 *
 * Deliberately mirrors the Solana account's meaningful fields and nothing more.
 * Keep them in sync: if you add a field on one chain, add it here too or the
 * mirror silently stops meaning the same thing.
 */
export const EAS_SCHEMA = "bytes32 subjectHash,uint8 score,uint8 method,uint64 issuedAt";

export type MirrorResult =
  | { status: "disabled"; reason: string }
  | { status: "ok"; uid: string; explorerUrl: string }
  | { status: "error"; reason: string };

function preflight(): string | null {
  if (!BASE_ENABLED) return "BASE_ENABLED is not true.";
  if (!EAS_SCHEMA_UID) return "EAS_SCHEMA_UID is not set — register the schema first.";
  if (!process.env.BASE_ATTESTER_SECRET) return "BASE_ATTESTER_SECRET is not set.";
  return null;
}

/**
 * Write the mirror attestation to Base.
 *
 * Returns rather than throws. A failed mirror is an operational problem, not a
 * verification failure — the caller records the Solana attestation regardless
 * and can retry the mirror later.
 */
export async function mirrorToBase(
  subjectHashHex: string,
  score: number,
  method: number,
  issuedAt: number,
): Promise<MirrorResult> {
  const blocked = preflight();
  if (blocked) return { status: "disabled", reason: blocked };

  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
    const signer = new ethers.Wallet(process.env.BASE_ATTESTER_SECRET!, provider);

    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(signer);

    const encoder = new SchemaEncoder(EAS_SCHEMA);
    const encoded = encoder.encodeData([
      { name: "subjectHash", value: prefixed(subjectHashHex), type: "bytes32" },
      { name: "score", value: score, type: "uint8" },
      { name: "method", value: method, type: "uint8" },
      { name: "issuedAt", value: issuedAt, type: "uint64" },
    ]);

    const tx = await eas.attest({
      schema: EAS_SCHEMA_UID,
      data: {
        // No EVM recipient: the subject is identified by hash, not by address.
        // Putting an address here would leak a link the hash exists to avoid.
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        data: encoded,
      },
    });

    const uid = await tx.wait();
    return { status: "ok", uid, explorerUrl: `${EAS_EXPLORER}/attestation/view/${uid}` };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : "Unknown error writing to Base.",
    };
  }
}

/** Revoke the mirror. Solana is still the source of truth for revocation. */
export async function revokeOnBase(uid: string): Promise<MirrorResult> {
  const blocked = preflight();
  if (blocked) return { status: "disabled", reason: blocked };

  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
    const signer = new ethers.Wallet(process.env.BASE_ATTESTER_SECRET!, provider);
    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(signer);

    const tx = await eas.revoke({ schema: EAS_SCHEMA_UID, data: { uid } });
    await tx.wait();
    return { status: "ok", uid, explorerUrl: `${EAS_EXPLORER}/attestation/view/${uid}` };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : "Unknown error revoking on Base.",
    };
  }
}

export function explorerUrl(uid: string): string {
  return `${EAS_EXPLORER}/attestation/view/${uid}`;
}

/** EAS wants 0x-prefixed bytes32; our hashes are stored bare. */
function prefixed(hex: string): string {
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}
