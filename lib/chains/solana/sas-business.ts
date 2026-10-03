/**
 * lib/chains/solana/sas-business.ts — verified businesses, on chain.
 *
 * A verified business (lib/sellers/business.ts) is recorded as a Solana
 * Attestation Service attestation, issued by SigPath's credential, so any app
 * can check it without asking SigPath, the same way it can check a seller's
 * badge or a report finding.
 *
 * FOUND FROM THE WALLET ALONE
 * The attestation's nonce is sha256("sigpath-business-v1" || wallet), so
 * anyone who knows the business's wallet derives the address directly. The
 * wallet also holds the business's verified-seller badges, which is what links
 * its marketplace accounts, so one public key leads to everything.
 *
 * HASHES, NOT DETAILS
 * Nothing on chain can be deleted, and a sole trader's VAT number is personal
 * data. So the VAT number and the website are stored as salted-by-purpose
 * hashes: sha256("sigpath-vat-v1\n" || country || number) and
 * sha256("sigpath-domain-v1\n" || domain). Someone who already has a VAT
 * number (from an invoice, say) can check it against the attestation; someone
 * reading the chain learns only the country and that a business verified.
 *
 * CHANGES AND REVOCATION
 * When the record changes (a website is added, the VAT check is renewed) the
 * attestation is closed and issued again at the same address. When the
 * business is suspended (an upheld fake-product report on any linked account)
 * it is closed, and the address simply holds nothing. It expires a year after
 * the VAT check, like the business tier itself.
 */

import { createHash } from "crypto";
import {
  deriveSchemaPda,
  deriveAttestationPda,
  getCreateAttestationInstruction,
  getCloseAttestationInstruction,
  serializeAttestationData,
  deserializeAttestationData,
  fetchSchema,
  fetchMaybeAttestation,
} from "sas-lib";
import { createSolanaRpc, getAddressEncoder, address as toAddress, type Address } from "@solana/kit";
import { addressFromBytes, deriveSigPathAddresses, describeError, explorerUrl, send, signer, type SasConfig, type SasResult } from "./sas";
import { bootstrapSchema } from "./sas-reports";

export const BUSINESS_SCHEMA_NAME = "verified-business";
export const BUSINESS_SCHEMA_VERSION = 1;
export const BUSINESS_SCHEMA_DESCRIPTION =
  "A business SigPath verified: an EU VAT number valid in the VIES register, marketplace accounts linked by one wallet, and optionally a website proved through DNS. VAT number and website are hashed.";
/** wallet, country, vatHash, domainHash: String; linkedAccounts: u8; verifiedAt: i64. */
export const BUSINESS_SCHEMA_LAYOUT = new Uint8Array([12, 12, 12, 12, 0, 8]);
export const BUSINESS_SCHEMA_FIELDS = ["wallet", "country", "vatHash", "domainHash", "linkedAccounts", "verifiedAt"];

export function vatHash(country: string, number: string): string {
  return createHash("sha256").update(`sigpath-vat-v1\n${country.toUpperCase()}${number.toUpperCase()}`).digest("hex");
}

export function domainHash(domain: string): string {
  return createHash("sha256").update(`sigpath-domain-v1\n${domain.toLowerCase()}`).digest("hex");
}

/** The nonce for a business's attestation. Anyone with the wallet can recompute it. */
export function businessNonce(wallet: string): Address {
  const bytes = Buffer.from(getAddressEncoder().encode(toAddress(wallet)));
  return addressFromBytes(new Uint8Array(createHash("sha256").update("sigpath-business-v1").update(bytes).digest()));
}

export async function deriveBusinessSchema(authority: Address) {
  const { credential } = await deriveSigPathAddresses(authority);
  const [schema] = await deriveSchemaPda({ credential, name: BUSINESS_SCHEMA_NAME, version: BUSINESS_SCHEMA_VERSION });
  return { credential, schema };
}

export async function businessAttestationAddress(authority: Address, wallet: string): Promise<Address> {
  const { credential, schema } = await deriveBusinessSchema(authority);
  const [attestation] = await deriveAttestationPda({ credential, schema, nonce: businessNonce(wallet) });
  return attestation;
}

/** Register the schema once per cluster. Safe to re-run. */
export async function bootstrapBusinessSchema(cfg: SasConfig): Promise<SasResult> {
  return bootstrapSchema(cfg, BUSINESS_SCHEMA_NAME, BUSINESS_SCHEMA_VERSION, BUSINESS_SCHEMA_DESCRIPTION, BUSINESS_SCHEMA_LAYOUT, BUSINESS_SCHEMA_FIELDS);
}

export interface BusinessOnChainInput {
  wallet: string;
  country: string;
  vatNumber: string;
  domain?: string;
  linkedAccounts: number;
  verifiedAt: number;
  expiresAt: number;
}

/**
 * Publish (or republish) a business's attestation. An existing one at the
 * address is closed first, in its own transaction, so the new one replaces it.
 */
export async function issueBusinessAttestation(cfg: SasConfig, b: BusinessOnChainInput): Promise<SasResult> {
  try {
    const authority = await signer(cfg);
    const { credential, schema } = await deriveBusinessSchema(authority.address);
    const nonce = businessNonce(b.wallet);
    const [attestation] = await deriveAttestationPda({ credential, schema, nonce });
    const rpc = createSolanaRpc(cfg.rpcUrl);

    if ((await fetchMaybeAttestation(rpc, attestation)).exists) {
      await send(cfg, [getCloseAttestationInstruction({ payer: authority, authority, credential, attestation })], authority);
    }
    const onChainSchema = await fetchSchema(rpc, schema);
    const data = serializeAttestationData(onChainSchema.data, {
      wallet: b.wallet,
      country: b.country,
      vatHash: vatHash(b.country, b.vatNumber),
      domainHash: b.domain ? domainHash(b.domain) : "",
      linkedAccounts: Math.min(255, b.linkedAccounts),
      verifiedAt: b.verifiedAt,
    } as never);
    const ix = getCreateAttestationInstruction({ payer: authority, authority, credential, schema, attestation, nonce, data, expiry: BigInt(b.expiresAt) });
    const signature = await send(cfg, [ix], authority);
    return { status: "ok", attestation, signature, explorer: explorerUrl(attestation, cfg.rpcUrl) };
  } catch (err) {
    return { status: "error", reason: describeError(err) };
  }
}

/** Close a business's attestation (suspension). Nothing there is not an error. */
export async function revokeBusinessAttestation(cfg: SasConfig, wallet: string): Promise<SasResult | { status: "none" }> {
  try {
    const authority = await signer(cfg);
    const { credential } = await deriveBusinessSchema(authority.address);
    const attestation = await businessAttestationAddress(authority.address, wallet);
    if (!(await fetchMaybeAttestation(createSolanaRpc(cfg.rpcUrl), attestation)).exists) return { status: "none" };
    const signature = await send(cfg, [getCloseAttestationInstruction({ payer: authority, authority, credential, attestation })], authority);
    return { status: "ok", attestation, signature, explorer: explorerUrl(attestation, cfg.rpcUrl) };
  } catch (err) {
    return { status: "error", reason: describeError(err) };
  }
}

export type OnChainBusiness =
  | { status: "none" }
  | { status: "expired"; attestation: string; expiresAt: number }
  | {
      status: "valid";
      attestation: string;
      country: string;
      vatHash: string;
      domainHash: string | null;
      linkedAccounts: number;
      verifiedAt: number;
      expiresAt: number;
    };

/** What any app can read from SigPath's issuer address and the business's wallet. No keys. */
export async function readVerifiedBusiness(authority: Address, wallet: string, rpcUrl: string, nowS = Math.floor(Date.now() / 1000)): Promise<OnChainBusiness> {
  const rpc = createSolanaRpc(rpcUrl);
  const { schema } = await deriveBusinessSchema(authority);
  const attestation = await businessAttestationAddress(authority, wallet);
  const att = await fetchMaybeAttestation(rpc, attestation);
  if (!att.exists) return { status: "none" };
  const expiresAt = Number(att.data.expiry);
  if (expiresAt !== 0 && nowS >= expiresAt) return { status: "expired", attestation, expiresAt };
  const d = deserializeAttestationData<{ wallet: string; country: string; vatHash: string; domainHash: string; linkedAccounts: number; verifiedAt: bigint | number }>(
    (await fetchSchema(rpc, schema)).data,
    att.data.data as Uint8Array,
  );
  if (d.wallet !== wallet) return { status: "none" };
  return {
    status: "valid",
    attestation,
    country: d.country,
    vatHash: d.vatHash,
    domainHash: d.domainHash || null,
    linkedAccounts: Number(d.linkedAccounts),
    verifiedAt: Number(d.verifiedAt),
    expiresAt,
  };
}
