/**
 * lib/chains/solana/sas-reports.ts — upheld fake-product reports, on chain.
 *
 * THE PENALTY HAS TO OUTLIVE SIGPATH'S DATABASE
 * A flag that only SigPath's search page shows is a penalty only on SigPath.
 * Written into the Solana Attestation Service, an upheld report is readable by
 * any marketplace, wallet or app — the same "verify once, readable anywhere"
 * property the footprint credential has, pointed at sellers who ship fakes.
 *
 * FINDING EVERY REPORT ABOUT A SELLER, WITH NOTHING BUT THE HANDLE
 * Each upheld report about a seller gets the next index: 0, 1, 2… The
 * attestation's nonce is sha256("sigpath-report-v1" || sellerSubject || index),
 * so anyone who knows the seller's handle can hash it, derive the address for
 * index 0, 1, 2… and stop at the first that does not exist. No indexer, no
 * API, no trust in SigPath's copy of the list.
 *
 * WHAT IS AND IS NOT ON CHAIN
 * The seller is identified by the same namespaced subject hash as everything
 * else here ("ebay:handle" hashed), not the raw handle. Nothing about the
 * buyer is published — not their wallet, not their words, not their photo.
 * Only a hash of the evidence, so the evidence SigPath holds can later be shown
 * to be the evidence the decision was made on.
 *
 * THE LIMIT, STATED HONESTLY
 * Contiguous indices make enumeration trivial, and they mean a report cannot
 * simply be deleted if a decision is later overturned — closing index 1 would
 * hide index 2. Overturning needs its own schema ("report reversed", same
 * nonce scheme) rather than a deletion. That is not built yet; nothing
 * published here is ever removed.
 */

import { createHash } from "crypto";
import {
  deriveSchemaPda,
  deriveAttestationPda,
  getCreateSchemaInstruction,
  getCreateAttestationInstruction,
  serializeAttestationData,
  fetchSchema,
  fetchMaybeSchema,
  fetchAllMaybeAttestation,
} from "sas-lib";
import { createSolanaRpc, type Address } from "@solana/kit";
import {
  addressFromBytes,
  deriveSigPathAddresses,
  describeError,
  explorerUrl,
  send,
  signer,
  type SasConfig,
  type SasResult,
} from "./sas";

export const REPORT_SCHEMA_NAME = "fake-report";
export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_SCHEMA_DESCRIPTION =
  "A fake-product report against a seller, filed by a verified buyer with live evidence and upheld after review.";
/**
 * sellerSubject: String (hex) | category: u8 | upheldAt: i64 | evidenceHash:
 * String (hex) | listingHash: String (hex). Codes checked against sas-lib's
 * compactLayoutMapping: 0 = u8, 8 = i64, 12 = String.
 */
export const REPORT_SCHEMA_LAYOUT = new Uint8Array([12, 0, 8, 12, 12]);
export const REPORT_SCHEMA_FIELDS = ["sellerSubject", "category", "upheldAt", "evidenceHash", "listingHash"];

/** Stable codes for what was wrong. Published, so never renumber. */
export const REPORT_CATEGORY_CODES = { counterfeit: 1, not_as_described: 2 } as const;
export type ReportCategory = keyof typeof REPORT_CATEGORY_CODES;

export async function deriveReportSchema(authority: Address) {
  const { credential } = await deriveSigPathAddresses(authority);
  const [schema] = await deriveSchemaPda({ credential, name: REPORT_SCHEMA_NAME, version: REPORT_SCHEMA_VERSION });
  return { credential, schema };
}

/** The nonce for a seller's Nth upheld report. Anyone can recompute it. */
export function reportNonce(sellerSubject: Uint8Array, index: number): Address {
  if (sellerSubject.length !== 32) throw new Error("sellerSubject must be 32 bytes.");
  if (!Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer.");
  const idx = Buffer.alloc(4);
  idx.writeUInt32LE(index);
  const h = createHash("sha256").update("sigpath-report-v1").update(sellerSubject).update(idx).digest();
  return addressFromBytes(new Uint8Array(h));
}

export async function reportAttestationAddress(
  authority: Address,
  sellerSubject: Uint8Array,
  index: number,
): Promise<Address> {
  const { credential, schema } = await deriveReportSchema(authority);
  const [attestation] = await deriveAttestationPda({ credential, schema, nonce: reportNonce(sellerSubject, index) });
  return attestation;
}

/** Register the report schema once per cluster. Safe to re-run: checks first, pays nothing if it exists. */
export async function bootstrapReportSchema(cfg: SasConfig): Promise<SasResult> {
  try {
    const authority = await signer(cfg);
    const { credential, schema } = await deriveReportSchema(authority.address);
    const rpc = createSolanaRpc(cfg.rpcUrl);

    if ((await fetchMaybeSchema(rpc, schema)).exists) {
      return { status: "exists", attestation: schema, explorer: explorerUrl(schema, cfg.rpcUrl) };
    }
    const credentialInfo = await rpc.getAccountInfo(credential, { encoding: "base64" }).send();
    if (!credentialInfo.value) {
      return {
        status: "error",
        reason: "The SigPath credential does not exist on this cluster yet. Run scripts/sas-bootstrap.ts first.",
      };
    }

    const ix = getCreateSchemaInstruction({
      payer: authority,
      authority,
      credential,
      schema,
      name: REPORT_SCHEMA_NAME,
      description: REPORT_SCHEMA_DESCRIPTION,
      layout: REPORT_SCHEMA_LAYOUT,
      fieldNames: REPORT_SCHEMA_FIELDS,
    });
    const signature = await send(cfg, [ix], authority);
    return { status: "ok", attestation: schema, signature, explorer: explorerUrl(schema, cfg.rpcUrl) };
  } catch (err) {
    return { status: "error", reason: describeError(err) };
  }
}

export interface UpheldReportOnChain {
  sellerSubject: Uint8Array;
  /** This seller's 0-based upheld-report count BEFORE this one. */
  index: number;
  category: ReportCategory;
  upheldAt: number;
  evidenceSha256: string;
  listingHash: string;
}

export async function issueReportAttestation(cfg: SasConfig, r: UpheldReportOnChain): Promise<SasResult> {
  try {
    const authority = await signer(cfg);
    const { credential, schema } = await deriveReportSchema(authority.address);
    const nonce = reportNonce(r.sellerSubject, r.index);
    const [attestation] = await deriveAttestationPda({ credential, schema, nonce });

    // Serialised against the schema AS DEPLOYED — see issueSasAttestation.
    const onChainSchema = await fetchSchema(createSolanaRpc(cfg.rpcUrl), schema);
    const data = serializeAttestationData(onChainSchema.data, {
      sellerSubject: Buffer.from(r.sellerSubject).toString("hex"),
      category: REPORT_CATEGORY_CODES[r.category],
      upheldAt: r.upheldAt,
      evidenceHash: r.evidenceSha256,
      listingHash: r.listingHash,
    } as never);

    const ix = getCreateAttestationInstruction({
      payer: authority,
      authority,
      credential,
      schema,
      attestation,
      nonce,
      data,
      // Never expires: a penalty that quietly lapses is not much of one.
      expiry: 0n,
    });
    const signature = await send(cfg, [ix], authority);
    return { status: "ok", attestation, signature, explorer: explorerUrl(attestation, cfg.rpcUrl) };
  } catch (err) {
    const reason = describeError(err);
    return {
      status: "error",
      reason: reason.includes("already in use")
        ? `Report index ${r.index} already exists for this seller — the local count is behind the chain.`
        : reason,
    };
  }
}

/**
 * Count a seller's upheld reports by walking indices until the first gap —
 * exactly what any third party would do, using only public inputs.
 */
export async function countSellerReportsOnChain(
  authority: Address,
  sellerSubject: Uint8Array,
  rpcUrl: string,
  max = 200,
): Promise<number> {
  const rpc = createSolanaRpc(rpcUrl);
  const BATCH = 10;
  for (let start = 0; start < max; start += BATCH) {
    const addrs = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => reportAttestationAddress(authority, sellerSubject, start + i)),
    );
    const found = await fetchAllMaybeAttestation(rpc, addrs);
    const firstMissing = found.findIndex((a) => !a.exists);
    if (firstMissing !== -1) return start + firstMissing;
  }
  return max;
}
