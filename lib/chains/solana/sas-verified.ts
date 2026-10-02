/**
 * lib/chains/solana/sas-verified.ts — the "Verified seller" token, on chain.
 *
 * WHAT IT IS
 * An attestation under the "verified-seller" schema, TOKENIZED by the
 * Solana Attestation Service: alongside the attestation account, SAS mints one
 * Token-2022 token into the seller's wallet. The mint is created by SAS itself
 * with NonTransferable, a PermanentDelegate and a MintCloseAuthority that are
 * all SAS's own PDA — so the token cannot be sold, given away or moved to a
 * fresh wallet, and only SAS (on the issuer's instruction) can burn it. That is
 * a soulbound token, built from the attestation SigPath already issues rather
 * than a separate NFT program.
 *
 * ONE PER SELLER HANDLE
 * The nonce is sha256("sigpath-verified-seller-v1" || sellerSubject): the
 * badge for a marketplace handle lives at one address anyone can derive from
 * the handle alone, exactly like the report indices. A handle can't hold two.
 *
 * WHAT IT IS NOT
 * It is a POSITIVE signal for sellers who opt in. It is not the penalty: the
 * penalty is the fake-report attestations, which are keyed to the handle and
 * exist whether or not the seller ever heard of SigPath. Revoking the badge
 * (on an upheld report) burns the token and closes the attestation — the
 * findings that caused it stay on chain untouched. Closing also returns the
 * rent, so a badge costs SigPath nothing permanent.
 *
 * Revocation can fail if the holder has burned the token themselves (holders
 * may burn their own Token-2022 tokens). Readers must therefore require the
 * token to be HELD, not just the attestation to exist — see readVerifiedSeller.
 */

import { createHash } from "crypto";
import {
  deriveAttestationPda,
  deriveAttestationMintPda,
  deriveSasAuthorityAddress,
  deriveSchemaMintPda,
  deriveSchemaPda,
  fetchMaybeAttestation,
  fetchSchema,
  getCloseTokenizedAttestationInstruction,
  getCreateTokenizedAttestationInstruction,
  getTokenizeSchemaInstruction,
  serializeAttestationData,
  deserializeAttestationData,
} from "sas-lib";
import { address, createSolanaRpc, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { addressFromBytes, deriveSigPathAddresses, describeError, explorerUrl, send, signer, type SasConfig, type SasResult } from "./sas";
import { bootstrapSchema } from "./sas-reports";

export const VERIFIED_SCHEMA_NAME = "verified-seller";
export const VERIFIED_SCHEMA_VERSION = 1;
export const VERIFIED_SCHEMA_DESCRIPTION =
  "SigPath verified seller: the holder proved control of this marketplace handle and passed a live camera check. Non-transferable; revoked if a fake-product report against the handle is upheld.";
/** sellerSubject (String, hex), verifiedAt (i64). */
export const VERIFIED_SCHEMA_LAYOUT = new Uint8Array([12, 8]);
export const VERIFIED_SCHEMA_FIELDS = ["sellerSubject", "verifiedAt"];

export const TOKEN_NAME = "SigPath Verified Seller";
export const TOKEN_SYMBOL = "SPVS";
/** A badge lapses after a year and must be renewed: verification is a claim about now. */
export const BADGE_VALIDITY_SECS = 365 * 24 * 3600;
/** The group (the schema's mint) can hold this many badges. */
const GROUP_MAX_SIZE = 1n << 32n;

export const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export async function deriveVerifiedSchema(authority: Address) {
  const { credential } = await deriveSigPathAddresses(authority);
  const [schema] = await deriveSchemaPda({ credential, name: VERIFIED_SCHEMA_NAME, version: VERIFIED_SCHEMA_VERSION });
  const [schemaMint] = await deriveSchemaMintPda({ schema });
  return { credential, schema, schemaMint };
}

export function verifiedNonce(sellerSubject: Uint8Array): Address {
  if (sellerSubject.length !== 32) throw new Error("sellerSubject must be 32 bytes.");
  const h = createHash("sha256").update("sigpath-verified-seller-v1").update(sellerSubject).digest();
  return addressFromBytes(new Uint8Array(h));
}

export async function verifiedAddresses(authority: Address, sellerSubject: Uint8Array) {
  const { credential, schema, schemaMint } = await deriveVerifiedSchema(authority);
  const [attestation] = await deriveAttestationPda({ credential, schema, nonce: verifiedNonce(sellerSubject) });
  const [attestationMint] = await deriveAttestationMintPda({ attestation });
  return { credential, schema, schemaMint, attestation, attestationMint };
}

/** The holder's Token-2022 associated token account for a mint. */
export async function token2022Ata(owner: Address, mint: Address): Promise<Address> {
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [enc.encode(owner), enc.encode(TOKEN_2022_PROGRAM), enc.encode(mint)],
  });
  return ata;
}

/**
 * Lamports SAS must fund the mint with: the 378 bytes it allocates (base mint
 * plus GroupMemberPointer, NonTransferable, MetadataPointer, PermanentDelegate
 * and MintCloseAuthority), then the TokenMetadata and TokenGroupMember
 * extensions Token-2022 reallocs in afterwards. Too little and the realloc
 * fails "below rent-exempt"; this is computed exactly, not padded.
 */
export function mintAccountSpace(name: string, symbol: string, uri: string, attestation: string, schema: string): number {
  const str = (s: string) => 4 + Buffer.byteLength(s, "utf8");
  const metadata =
    4 + // TLV header
    32 + // update authority
    32 + // mint
    str(name) +
    str(symbol) +
    str(uri) +
    4 + // additional_metadata vec length
    str("attestation") +
    str(attestation) +
    str("schema") +
    str(schema);
  const groupMember = 4 + 32 + 32 + 8;
  return 378 + metadata + groupMember;
}

/** Register and tokenize the schema, once per cluster. Re-runnable: checks before paying. */
export async function bootstrapVerifiedSchema(cfg: SasConfig): Promise<SasResult> {
  const created = await bootstrapSchema(
    cfg,
    VERIFIED_SCHEMA_NAME,
    VERIFIED_SCHEMA_VERSION,
    VERIFIED_SCHEMA_DESCRIPTION,
    VERIFIED_SCHEMA_LAYOUT,
    VERIFIED_SCHEMA_FIELDS,
  );
  if (created.status === "error" || created.status === "disabled") return created;
  try {
    const authority = await signer(cfg);
    const { credential, schema, schemaMint } = await deriveVerifiedSchema(authority.address);
    const rpc = createSolanaRpc(cfg.rpcUrl);
    if ((await rpc.getAccountInfo(schemaMint, { encoding: "base64" }).send()).value) {
      return { status: "exists", attestation: schemaMint, explorer: explorerUrl(schemaMint, cfg.rpcUrl) };
    }
    const ix = getTokenizeSchemaInstruction({
      payer: authority,
      authority,
      credential,
      schema,
      mint: schemaMint,
      sasPda: await deriveSasAuthorityAddress(),
      maxSize: GROUP_MAX_SIZE,
    });
    const signature = await send(cfg, [ix], authority);
    return { status: "ok", attestation: schemaMint, signature, explorer: explorerUrl(schemaMint, cfg.rpcUrl) };
  } catch (err) {
    return { status: "error", reason: describeError(err) };
  }
}

export interface VerifiedBadgeIssue {
  sellerSubject: Uint8Array;
  wallet: string;
  verifiedAt: number;
  /** Where the token's metadata points: the seller's public SigPath page. */
  uri: string;
}

export type BadgeIssueResult =
  | { status: "ok"; attestation: string; mint: string; tokenAccount: string; expiresAt: number; signature: string; explorer: string }
  | { status: "error"; reason: string };

export async function issueVerifiedBadge(cfg: SasConfig, b: VerifiedBadgeIssue): Promise<BadgeIssueResult> {
  try {
    const authority = await signer(cfg);
    const a = await verifiedAddresses(authority.address, b.sellerSubject);
    const recipient = address(b.wallet);
    const recipientTokenAccount = await token2022Ata(recipient, a.attestationMint);
    const rpc = createSolanaRpc(cfg.rpcUrl);

    const onChainSchema = await fetchSchema(rpc, a.schema);
    const data = serializeAttestationData(onChainSchema.data, {
      sellerSubject: Buffer.from(b.sellerSubject).toString("hex"),
      verifiedAt: b.verifiedAt,
    } as never);
    const expiresAt = b.verifiedAt + BADGE_VALIDITY_SECS;

    const ix = getCreateTokenizedAttestationInstruction({
      payer: authority,
      authority,
      credential: a.credential,
      schema: a.schema,
      attestation: a.attestation,
      schemaMint: a.schemaMint,
      attestationMint: a.attestationMint,
      sasPda: await deriveSasAuthorityAddress(),
      recipientTokenAccount,
      recipient,
      nonce: verifiedNonce(b.sellerSubject),
      data,
      expiry: BigInt(expiresAt),
      name: TOKEN_NAME,
      uri: b.uri,
      symbol: TOKEN_SYMBOL,
      mintAccountSpace: mintAccountSpace(TOKEN_NAME, TOKEN_SYMBOL, b.uri, a.attestation, a.schema),
    });
    const signature = await send(cfg, [ix], authority);
    return {
      status: "ok",
      attestation: a.attestation,
      mint: a.attestationMint,
      tokenAccount: recipientTokenAccount,
      expiresAt,
      signature,
      explorer: explorerUrl(a.attestation, cfg.rpcUrl),
    };
  } catch (err) {
    const reason = describeError(err);
    return {
      status: "error",
      reason: reason.includes("already in use") ? "This handle already holds a verified-seller badge." : reason,
    };
  }
}

/** Burn the token and close the badge. The rent comes back to the issuer. */
export async function revokeVerifiedBadge(cfg: SasConfig, sellerSubject: Uint8Array): Promise<SasResult> {
  try {
    const authority = await signer(cfg);
    const a = await verifiedAddresses(authority.address, sellerSubject);
    const rpc = createSolanaRpc(cfg.rpcUrl);
    const att = await fetchMaybeAttestation(rpc, a.attestation);
    if (!att.exists) return { status: "error", reason: "This handle holds no verified-seller badge." };

    const ix = getCloseTokenizedAttestationInstruction({
      payer: authority,
      authority,
      credential: a.credential,
      attestation: a.attestation,
      attestationMint: a.attestationMint,
      sasPda: await deriveSasAuthorityAddress(),
      attestationTokenAccount: att.data.tokenAccount,
    });
    const signature = await send(cfg, [ix], authority);
    return { status: "ok", attestation: a.attestation, signature, explorer: explorerUrl(a.attestation, cfg.rpcUrl) };
  } catch (err) {
    return { status: "error", reason: describeError(err) };
  }
}

export type OnChainBadge =
  | { status: "none" }
  | { status: "expired" | "not_held"; attestation: string; holder: string | null; expiresAt: number }
  | { status: "valid"; attestation: string; mint: string; holder: string; verifiedAt: number; expiresAt: number };

/**
 * What any app can check from the handle and SigPath's public issuer address:
 * does a badge exist, has it lapsed, and is the token actually still held?
 * Reads only — no keys.
 */
export async function readVerifiedSeller(
  authority: Address,
  sellerSubject: Uint8Array,
  rpcUrl: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<OnChainBadge> {
  const rpc = createSolanaRpc(rpcUrl);
  const a = await verifiedAddresses(authority, sellerSubject);
  const att = await fetchMaybeAttestation(rpc, a.attestation);
  if (!att.exists) return { status: "none" };

  const expiresAt = Number(att.data.expiry);
  const tokenInfo = await rpc.getAccountInfo(att.data.tokenAccount, { encoding: "base64" }).send();
  const raw = tokenInfo.value ? Buffer.from(tokenInfo.value.data[0], "base64") : null;
  // Token account layout: mint(32) owner(32) amount(u64) …
  const holder = raw && raw.length >= 72 ? addressFromBytes(new Uint8Array(raw.subarray(32, 64))) : null;
  const held = !!raw && raw.length >= 72 && raw.readBigUInt64LE(64) === 1n && raw.subarray(0, 32).equals(Buffer.from(getAddressEncoder().encode(a.attestationMint)));

  if (expiresAt !== 0 && nowS >= expiresAt) return { status: "expired", attestation: a.attestation, holder, expiresAt };
  if (!held || !holder) return { status: "not_held", attestation: a.attestation, holder, expiresAt };

  const schema = await fetchSchema(rpc, a.schema);
  const decoded = deserializeAttestationData<{ verifiedAt: bigint | number }>(schema.data, att.data.data as Uint8Array);
  return { status: "valid", attestation: a.attestation, mint: a.attestationMint, holder, verifiedAt: Number(decoded.verifiedAt), expiresAt };
}
