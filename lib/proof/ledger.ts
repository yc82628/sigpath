/**
 * lib/proof/ledger.ts — what /proof shows: SigPath's record, read from Solana.
 *
 * WHY
 * A new shopping site that takes crypto looks like a scam until it shows
 * otherwise, and "trust us" is exactly what a scam says. So /proof shows nothing
 * from SigPath's own database: every number and every row here is read from
 * Solana, from addresses anyone can open in an explorer, and would read the same
 * if SigPath's servers were gone.
 *
 * WHAT IS READ
 *   - Every escrow order the orders program holds (programs/sigpath_orders):
 *     how many were paid out, how many refunded, how much USDC waits now.
 *   - Every upheld fake-product finding and every reversal SigPath has published
 *     to the Solana Attestation Service, and how many verified-seller badges and
 *     verified businesses stand.
 * Two getProgramAccounts calls per kind, filtered on chain to SigPath's own
 * schemas and program, so the cost does not grow with anyone else's records.
 *
 * WHAT IS NOT
 * Sellers appear as their subject hash, as they are on chain: SigPath never
 * publishes a raw handle. Anyone who knows a handle can hash it and find its
 * record (the seller page does exactly that). Buyers appear nowhere.
 *
 * COST
 * The answer is kept for five minutes per server instance; a failed read keeps
 * the last good one rather than showing zeros that were never true.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { address, createSolanaRpc, getBase58Decoder, type Address } from "@solana/kit";
import { deserializeAttestationData, fetchSchema, getAttestationDecoder } from "sas-lib";
import { SOLANA_RPC_URL } from "../config";
import { SAS_PROGRAM_ID, deriveSigPathAddresses, explorerUrl } from "../chains/solana/sas";
import {
  REPORT_CATEGORY_CODES,
  deriveReportSchema,
  deriveReversalSchema,
  reportNonce,
  type ReportCategory,
} from "../chains/solana/sas-reports";
import { deriveVerifiedSchema } from "../chains/solana/sas-verified";
import { deriveBusinessSchema } from "../chains/solana/sas-business";
import {
  ORDERS_PROGRAM_ID,
  ORDER_ACCOUNT_DISCRIMINATOR,
  ORDER_LAYOUT,
  OPERATOR,
  decodeOrder,
  type OrderStatus,
} from "../chains/solana/orders";

/**
 * SigPath's public key. The same key issues the attestations and operates the
 * escrow (README, "Live on devnet"), so one address names everything SigPath
 * has ever signed.
 */
export const ISSUER: Address = address(OPERATOR.toBase58());

/** In an SAS attestation account: discriminator (1), nonce (32), credential (32), then the schema. */
const SCHEMA_OFFSET = 1 + 32 + 32;

export interface OrderSummary {
  total: number;
  /** Paid in and waiting: released only by fulfilment before the deadline, or refunded after it. */
  funded: number;
  fulfilled: number;
  refunded: number;
  /** In USDC base units (6 decimals). */
  heldNow: number;
  paidOut: number;
  returned: number;
}

export interface ProofFinding {
  /** The upheld finding's attestation address. */
  address: string;
  /** The seller's subject hash, hex: sha256("ebay:handle"). */
  subject: string;
  category: ReportCategory | null;
  upheldAt: number;
  /** The seller's report number (0, 1, 2…), recovered from the attestation's nonce; null if it can't be. */
  index: number | null;
  reversal: { address: string; at: number } | null;
}

export interface Proof {
  readAt: number;
  orders: OrderSummary;
  /** Newest first. */
  findings: ProofFinding[];
  badges: number;
  businesses: number;
  links: Record<"issuer" | "ordersProgram" | "credential" | "reportSchema" | "reversalSchema" | "verifiedSchema" | "businessSchema", string>;
}

// ---------------------------------------------------------------------------
// Pure parts (tests/proof.test.ts)
// ---------------------------------------------------------------------------

export function summariseOrders(orders: { status: OrderStatus; amount: bigint }[]): OrderSummary {
  const s: OrderSummary = { total: orders.length, funded: 0, fulfilled: 0, refunded: 0, heldNow: 0, paidOut: 0, returned: 0 };
  for (const o of orders) {
    const amount = Number(o.amount);
    s[o.status] += 1;
    if (o.status === "funded") s.heldNow += amount;
    if (o.status === "fulfilled") s.paidOut += amount;
    if (o.status === "refunded") s.returned += amount;
  }
  return s;
}

export interface RawReport {
  address: string;
  nonce: string;
  subject: string;
  category: number;
  upheldAt: number;
}
export interface RawReversal {
  address: string;
  subject: string;
  reportIndex: number;
  reversedAt: number;
}

const CATEGORY_OF = Object.fromEntries(Object.entries(REPORT_CATEGORY_CODES).map(([k, v]) => [v, k as ReportCategory]));

/**
 * Pair findings with their reversals. A report's index isn't in its data, but
 * its nonce is sha256("sigpath-report-v1" || subject || index), and a seller's
 * reports are numbered 0, 1, 2… without gaps: try each in turn.
 */
export function linkFindings(reports: RawReport[], reversals: RawReversal[]): ProofFinding[] {
  const perSubject = new Map<string, number>();
  for (const r of reports) perSubject.set(r.subject, (perSubject.get(r.subject) ?? 0) + 1);

  return reports
    .map((r) => {
      let index: number | null = null;
      const subjectBytes = /^[0-9a-f]{64}$/.test(r.subject) ? Buffer.from(r.subject, "hex") : null;
      if (subjectBytes) {
        for (let i = 0; i < (perSubject.get(r.subject) ?? 0) + 1; i++) {
          if (reportNonce(subjectBytes, i) === r.nonce) {
            index = i;
            break;
          }
        }
      }
      const rev = index === null ? undefined : reversals.find((v) => v.subject === r.subject && v.reportIndex === index);
      return {
        address: r.address,
        subject: r.subject,
        category: CATEGORY_OF[r.category] ?? null,
        upheldAt: r.upheldAt,
        index,
        reversal: rev ? { address: rev.address, at: rev.reversedAt } : null,
      };
    })
    .sort((a, b) => b.upheldAt - a.upheldAt);
}

// ---------------------------------------------------------------------------
// Reading the chain
// ---------------------------------------------------------------------------

async function attestationsOf(conn: Connection, schema: Address) {
  const accounts = await conn.getProgramAccounts(new PublicKey(SAS_PROGRAM_ID), {
    filters: [{ memcmp: { offset: SCHEMA_OFFSET, bytes: schema } }],
  });
  const decoder = getAttestationDecoder();
  return accounts.map((a) => ({ address: a.pubkey.toBase58(), ...decoder.decode(new Uint8Array(a.account.data)) }));
}

export async function readProof(rpcUrl: string = SOLANA_RPC_URL): Promise<Proof> {
  const conn = new Connection(rpcUrl, "confirmed");
  const rpc = createSolanaRpc(rpcUrl);
  const { credential } = await deriveSigPathAddresses(ISSUER);
  const { schema: reportSchema } = await deriveReportSchema(ISSUER);
  const { schema: reversalSchema } = await deriveReversalSchema(ISSUER);
  const { schema: verifiedSchema } = await deriveVerifiedSchema(ISSUER);
  const { schema: businessSchema } = await deriveBusinessSchema(ISSUER);

  const [orderAccounts, reports, reversals, badges, businesses] = await Promise.all([
    conn.getProgramAccounts(ORDERS_PROGRAM_ID, {
      filters: [{ dataSize: ORDER_LAYOUT.size }, { memcmp: { offset: 0, bytes: getBase58Decoder().decode(ORDER_ACCOUNT_DISCRIMINATOR) } }],
    }),
    attestationsOf(conn, reportSchema),
    attestationsOf(conn, reversalSchema),
    attestationsOf(conn, verifiedSchema),
    attestationsOf(conn, businessSchema),
  ]);

  // Decoded against the schemas as deployed, like every other read here.
  const [reportLayout, reversalLayout] = await Promise.all([
    reports.length ? fetchSchema(rpc, reportSchema) : null,
    reversals.length ? fetchSchema(rpc, reversalSchema) : null,
  ]);
  type ReportData = { sellerSubject: string; category: number; upheldAt: bigint | number };
  type ReversalData = { sellerSubject: string; reportIndex: bigint | number; reversedAt: bigint | number };

  const rawReports: RawReport[] = reportLayout
    ? reports.map((a) => {
        const d = deserializeAttestationData<ReportData>(reportLayout.data, a.data as Uint8Array);
        return { address: a.address, nonce: a.nonce, subject: d.sellerSubject, category: Number(d.category), upheldAt: Number(d.upheldAt) };
      })
    : [];
  const rawReversals: RawReversal[] = reversalLayout
    ? reversals.map((a) => {
        const d = deserializeAttestationData<ReversalData>(reversalLayout.data, a.data as Uint8Array);
        return { address: a.address, subject: d.sellerSubject, reportIndex: Number(d.reportIndex), reversedAt: Number(d.reversedAt) };
      })
    : [];

  const orders: { status: OrderStatus; amount: bigint }[] = [];
  for (const a of orderAccounts) {
    try {
      orders.push(decodeOrder(a.account.data));
    } catch {
      // Not an order this client understands: left out rather than guessed at.
    }
  }

  const link = (a: string) => explorerUrl(a, rpcUrl);
  return {
    readAt: Math.floor(Date.now() / 1000),
    orders: summariseOrders(orders),
    findings: linkFindings(rawReports, rawReversals),
    badges: badges.length,
    businesses: businesses.length,
    links: {
      issuer: link(ISSUER),
      ordersProgram: link(ORDERS_PROGRAM_ID.toBase58()),
      credential: link(credential),
      reportSchema: link(reportSchema),
      reversalSchema: link(reversalSchema),
      verifiedSchema: link(verifiedSchema),
      businessSchema: link(businessSchema),
    },
  };
}

const TTL_SECS = 5 * 60;
let kept: Proof | null = null;
let pending: Promise<Proof | null> | null = null;

/** readProof, kept five minutes. Null only if the chain has never answered this instance. */
export function proof(rpcUrl: string = SOLANA_RPC_URL): Promise<Proof | null> {
  if (kept && Date.now() / 1000 - kept.readAt < TTL_SECS) return Promise.resolve(kept);
  pending ??= readProof(rpcUrl)
    .then((p) => (kept = p))
    .catch(() => kept)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Whether the chain read is devnet's: the page says so beside every number. */
export const ON_DEVNET = SOLANA_RPC_URL.includes("devnet");
