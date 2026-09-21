/**
 * lib/chains/solana/sas.ts — issuing into Solana Attestation Service.
 *
 * WHY THIS EXISTS
 * Without it, a SigPath verification lives in a SigPath PDA that only SigPath
 * can read — another identity silo, and the weakest part of any "why Solana"
 * answer, because a bespoke registry is equally possible on any chain.
 *
 * SAS is Solana's own credential standard. Issuing into it means a lending
 * protocol, a DAO gate or a marketplace can act on a SigPath verification
 * without knowing SigPath exists. Verify once, readable everywhere, with no
 * bilateral integration. That is a property no other chain currently offers.
 *
 * TWO SDKS IN ONE PROJECT — DELIBERATE
 * sas-lib depends on @solana/kit v5 (the new API: Address, TransactionSigner,
 * instruction builders). The rest of this project uses @solana/web3.js v1
 * (PublicKey, Transaction). They are different libraries with incompatible
 * types.
 *
 * Migrating everything to kit would be a rewrite of client.ts, instructions.ts,
 * the attest route and the verify page — not something to attempt days before a
 * deadline. So this module is the ONLY place kit is used, and the boundary is
 * base58 strings, which both SDKs speak. Do not leak kit types out of this file.
 *
 * RELATIONSHIP TO THE SIGPATH PROGRAM
 * SigPath's own program stays the detailed record: it carries the method
 * bitfield, the LIVE_CAPTURE flag and the Base mirror UID, which a generic
 * schema cannot express as richly. SAS carries the portable summary. Same
 * pattern as the Base mirror: one writer, one broadcast.
 */

import {
  SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
  deriveCredentialPda,
  deriveSchemaPda,
  deriveAttestationPda,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  getCreateAttestationInstruction,
  serializeAttestationData,
  fetchSchema,
} from "sas-lib";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  appendTransactionMessageInstructions,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  pipe,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { bytesToHex } from "../../crypto/hash";

export const SAS_PROGRAM_ID = SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS;

/** One credential per issuer. Ours. */
export const CREDENTIAL_NAME = "SigPath";

/**
 * The schema SigPath issues under.
 *
 * Deliberately a SUMMARY, not a mirror of the full on-chain record. A consumer
 * gating on "is this subject corroborated?" needs the score and the method
 * bits; it does not need our internal signal breakdown. Keeping the schema
 * small also keeps it cheap and stable — every field added here is a migration
 * for every consumer already reading it.
 *
 * `layout` uses SAS field-type codes; `fieldNames` labels them in the same
 * order. Codes verified against compactLayoutMapping in sas-lib's utils.js:
 *   0 = u8, 3 = u64, 8 = i64, 10 = bool, 12 = String
 * Do NOT guess these. An earlier version used 6 for i64; 6 is i16, which would
 * have silently truncated every timestamp. Keep the two arrays the same length
 * and the same order or the decode is wrong with no error.
 */
export const SCHEMA_NAME = "footprint";
export const SCHEMA_VERSION = 1;
export const SCHEMA_DESCRIPTION =
  "Digital footprint verification: corroboration score and how it was reached.";
/** score: u8, method: u8, issuedAt: i64. Bytes, not number[] — the SDK wants a
 *  ReadonlyUint8Array here and silently mistypes otherwise. */
export const SCHEMA_LAYOUT = new Uint8Array([0, 0, 8]);
export const SCHEMA_FIELDS = ["score", "method", "issuedAt"];

export interface SasConfig {
  rpcUrl: string;
  wsUrl: string;
  /** Issuer keypair as the 64-byte secret, same shape as ISSUER_SECRET. */
  secretKey: Uint8Array;
}

export type SasResult =
  | { status: "disabled"; reason: string }
  | { status: "ok"; attestation: string; signature: string; explorer: string }
  | { status: "error"; reason: string };

function rpcUrlToWs(url: string): string {
  return url.replace(/^http/, "ws");
}

export function sasConfigFromEnv(): SasConfig | null {
  // Off unless explicitly enabled, like the Base mirror. The SigPath write must
  // never depend on SAS being reachable.
  if (process.env.SAS_ENABLED !== "true") return null;
  const raw = process.env.ISSUER_SECRET;
  if (!raw) return null;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
  return {
    rpcUrl,
    wsUrl: process.env.SOLANA_WS_URL ?? rpcUrlToWs(rpcUrl),
    secretKey: Uint8Array.from(JSON.parse(raw)),
  };
}

async function signer(cfg: SasConfig): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(cfg.secretKey);
}

/** Where our credential and schema live. Deterministic — safe to call anywhere. */
export async function deriveSigPathAddresses(authority: Address) {
  const [credential] = await deriveCredentialPda({ authority, name: CREDENTIAL_NAME });
  const [schema] = await deriveSchemaPda({
    credential,
    name: SCHEMA_NAME,
    version: SCHEMA_VERSION,
  });
  return { credential, schema };
}

/**
 * The attestation address for a subject.
 *
 * The nonce IS the subject hash. A 32-byte hash is a valid Address, so the SAS
 * attestation derives from exactly the same commitment as SigPath's own PDA —
 * same privacy property (no raw handle on chain), and anyone who knows the
 * subject can find both records by re-hashing it.
 */
export async function deriveSubjectAttestation(
  authority: Address,
  subjectHash: Uint8Array,
): Promise<{ credential: Address; schema: Address; attestation: Address; nonce: Address }> {
  if (subjectHash.length !== 32) {
    throw new Error(`subjectHash must be 32 bytes, got ${subjectHash.length}`);
  }
  const { credential, schema } = await deriveSigPathAddresses(authority);
  const nonce = addressFromBytes(subjectHash);
  const [attestation] = await deriveAttestationPda({ credential, schema, nonce });
  return { credential, schema, attestation, nonce };
}

/** 32 raw bytes -> an Address. Used to carry the subject hash as the nonce. */
function addressFromBytes(bytes: Uint8Array): Address {
  // Addresses are base58 of 32 bytes; kit's `address()` validates that for us.
  return address(base58Encode(bytes));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Leading zero bytes encode as '1' each, and are load-bearing: dropping them
  // produces a shorter string that decodes to a different value.
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

async function send(cfg: SasConfig, instructions: unknown[], payer: KeyPairSigner) {
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(cfg.wsUrl);
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m) => appendTransactionMessageInstructions(instructions as any, m),
  );

  const signed = await signTransactionMessageWithSigners(message);
  // `pipe` widens the lifetime to blockhash | durable-nonce, and the factory
  // only accepts the blockhash variant. We set a blockhash lifetime six lines
  // up, so the narrowing is sound — the type system just cannot see through the
  // pipe. Asserting the specific parameter type rather than `any` keeps the
  // rest of the call checked.
  const confirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await confirm(signed as Parameters<typeof confirm>[0], { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

/**
 * One-time bootstrap: register the credential and schema.
 *
 * Idempotent in the sense that a second run fails with "already in use" rather
 * than corrupting anything — but it is not free, so run it once per cluster and
 * record the addresses.
 */
export async function bootstrapSasIssuer(cfg: SasConfig): Promise<SasResult> {
  try {
    const authority = await signer(cfg);
    const { credential, schema } = await deriveSigPathAddresses(authority.address);

    const ixs = [
      getCreateCredentialInstruction({
        payer: authority,
        credential,
        authority,
        name: CREDENTIAL_NAME,
        signers: [authority.address],
      }),
      getCreateSchemaInstruction({
        payer: authority,
        authority,
        credential,
        schema,
        name: SCHEMA_NAME,
        description: SCHEMA_DESCRIPTION,
        layout: SCHEMA_LAYOUT,
        fieldNames: SCHEMA_FIELDS,
      }),
    ];

    const signature = await send(cfg, ixs, authority);
    return {
      status: "ok",
      attestation: schema,
      signature,
      explorer: explorerUrl(schema, cfg.rpcUrl),
    };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Issue a SAS attestation for a subject.
 *
 * Returns rather than throws: a failed SAS write is an operational problem, not
 * a verification failure. The caller has already recorded the SigPath
 * attestation and can retry this independently.
 */
export async function issueSasAttestation(
  subjectHash: Uint8Array,
  score: number,
  method: number,
  expiresAtUnix: number,
  cfg: SasConfig | null = sasConfigFromEnv(),
): Promise<SasResult> {
  if (!cfg) return { status: "disabled", reason: "SAS_ENABLED is not true, or ISSUER_SECRET is unset." };

  try {
    const authority = await signer(cfg);
    const { credential, schema, attestation, nonce } = await deriveSubjectAttestation(
      authority.address,
      subjectHash,
    );

    // Serialize against the schema AS DEPLOYED, not a local reconstruction.
    // serializeAttestationData expects the on-chain account, where fieldNames is
    // a joined length-prefixed byte vec rather than a string array. Fetching it
    // also means that if the deployed schema ever diverges from the constants in
    // this file, the write fails loudly instead of encoding garbage that decodes
    // to plausible-looking wrong numbers.
    const rpcForSchema = createSolanaRpc(cfg.rpcUrl);
    const onChainSchema = await fetchSchema(rpcForSchema, schema);
    const data = serializeAttestationData(onChainSchema.data, {
      score,
      method,
      issuedAt: Math.floor(Date.now() / 1000),
    } as never);

    const ix = getCreateAttestationInstruction({
      payer: authority,
      authority,
      credential,
      schema,
      attestation,
      nonce,
      data,
      expiry: BigInt(expiresAtUnix),
    });

    const signature = await send(cfg, [ix], authority);
    return {
      status: "ok",
      attestation,
      signature,
      explorer: explorerUrl(attestation, cfg.rpcUrl),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      reason: reason.includes("already in use")
        ? `A SAS attestation already exists for subject ${bytesToHex(subjectHash).slice(0, 16)}…`
        : reason,
    };
  }
}

function explorerUrl(addr: string, rpcUrl: string): string {
  const cluster = rpcUrl.includes("devnet")
    ? "?cluster=devnet"
    : rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")
      ? "?cluster=custom"
      : "";
  return `https://explorer.solana.com/address/${addr}${cluster}`;
}
