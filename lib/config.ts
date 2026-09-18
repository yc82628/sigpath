/**
 * lib/config.ts — one place where environment turns into typed config.
 *
 * Everything reads config from here rather than touching process.env directly,
 * so a missing variable fails loudly at one known point instead of surfacing as
 * `undefined` three layers down inside an RPC call.
 */

/** Which chain a piece of code is talking to. */
export type Chain = "solana" | "base";

// ---------------------------------------------------------------------------
// Solana — the source of truth
// ---------------------------------------------------------------------------

export const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

/** Populated by `anchor keys sync` + copied into .env.local after first deploy. */
export const SOLANA_PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID ?? "";

// ---------------------------------------------------------------------------
// Base — the optional mirror
// ---------------------------------------------------------------------------

/**
 * Base is OFF by default and the Solana path must work without it. Anything
 * Base-related is wrapped in this check, so a missing EVM key degrades the app
 * to Solana-only rather than breaking it.
 */
export const BASE_ENABLED = process.env.BASE_ENABLED === "true";

export const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";

/** EAS schema UID, registered once. See README "Enabling Base". */
export const EAS_SCHEMA_UID = process.env.EAS_SCHEMA_UID ?? "";

/**
 * EAS contract. The OP Stack predeploy address is the default on Base and Base
 * Sepolia; override only if you are targeting a network where it differs.
 */
export const EAS_CONTRACT_ADDRESS =
  process.env.EAS_CONTRACT_ADDRESS ?? "0x4200000000000000000000000000000000000021";

export const EAS_EXPLORER =
  process.env.NEXT_PUBLIC_EAS_EXPLORER ?? "https://base-sepolia.easscan.org";

// ---------------------------------------------------------------------------
// Attestation policy
// ---------------------------------------------------------------------------

/**
 * How long an attestation stays fresh. Freshness matters: a verification from
 * two years ago does not tell you the accounts still belong to the same person.
 * An expired attestation is NOT a failed one — surface it as its own state.
 * 0 disables expiry.
 */
export const ATTESTATION_TTL_SECONDS = Number(
  process.env.ATTESTATION_TTL_SECONDS ?? 90 * 24 * 60 * 60,
);

/** Throws with a useful message instead of letting `undefined` travel. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See .env.local.example.`);
  return v;
}
