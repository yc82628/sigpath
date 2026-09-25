/**
 * lib/chains/solana/orders.ts — client for programs/sigpath_orders.
 *
 * SERVER-SIDE. Instructions are built here and the unsigned transaction is
 * handed to the shopper's wallet to sign (the Solana Pay "transaction request"
 * pattern). Two reasons it lives on the server rather than in the browser:
 *
 *   1. The AMOUNT comes from the server's own quote of the listing price. If
 *      the browser built the instruction, editing one number in devtools would
 *      create an order for less than the item costs.
 *   2. Discriminators use node:crypto, which the browser bundle does not have.
 *
 * Like the attestation program there is no IDL — the toolchain cannot generate
 * one (README, trap #3) — so the encodings below mirror lib.rs by hand. The
 * account layouts and error order are pinned by tests/orders.test.ts, and the
 * whole flow is proven against a live validator by scripts/orders-roundtrip.ts.
 */

import { createHash } from "crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { discriminator } from "./instructions";
import { TOKEN_PROGRAM_ID, associatedTokenAddress } from "./spl";

/** Mirrors declare_id! in programs/sigpath_orders/src/lib.rs. */
export const ORDERS_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ORDERS_PROGRAM_ID ?? "3gWtrK2mxrW5udZuYxQaeAKwTFx2VbD8WfShBMpgHBwW",
);
/** Mirrors OPERATOR. The only key that can fulfil — and be paid for — an order. */
export const OPERATOR = new PublicKey("AaFcCzgJ53SPpqheu8KGM6fA3i4cwd57SL8goz6jdfXg");
/** Mirrors USDC_MINT: Circle's devnet USDC. */
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const USDC_DECIMALS = 6;

/** Mirrors MIN_WINDOW_SECS / MAX_WINDOW_SECS / MAX_AMOUNT. */
export const MIN_WINDOW_SECS = 60;
export const MAX_WINDOW_SECS = 30 * 24 * 3600;
export const MAX_AMOUNT = 1_000n * 1_000_000n;

export const ORDER_STATUS = { funded: 0, fulfilled: 1, refunded: 2 } as const;
export type OrderStatus = keyof typeof ORDER_STATUS;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

export function orderPda(buyer: PublicKey, nonce: bigint, programId = ORDERS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("order"), buyer.toBuffer(), u64le(nonce)], programId);
}

export function vaultPda(order: PublicKey, programId = ORDERS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), order.toBuffer()], programId);
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

/**
 * 32-byte commitment to exactly what is being bought. Stored on the order, so
 * it cannot later be claimed to have been for a different listing. Source and
 * id are included, not just the URL, because the same URL can carry different
 * tracking parameters for one listing.
 */
export function listingHash(listing: { source: string; id: string; url: string }): Buffer {
  return createHash("sha256").update(`${listing.source}\n${listing.id}\n${listing.url}`).digest();
}

/**
 * 32-byte commitment to the retailer's order number or tracking reference.
 * Hashed so the reference itself (which may identify the buyer's address) is
 * not published, while the buyer — who knows it — can still check it.
 */
export function fulfilmentRefHash(reference: string): Buffer {
  const trimmed = reference.trim();
  if (!trimmed) throw new Error("A fulfilment reference is required.");
  return createHash("sha256").update(trimmed).digest();
}

/** "12.34" -> 12_340_000n base units, without float arithmetic. */
export function usdcToBaseUnits(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a USDC amount: "${value}"`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/**
 * Exact, never truncated: 155_727_900n -> "155.7279 USDC", 12_340_000n ->
 * "12.34 USDC". A display cut to two decimals would show 155.72 while the
 * wallet charges 155.7279 — understating what is taken, however slightly, is
 * the one direction a price display must never err in.
 */
export function formatUsdc(base: bigint): string {
  const whole = base / 1_000_000n;
  let frac = (base % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac} USDC`;
}

// ---------------------------------------------------------------------------
// Instructions — account order MUST match the #[derive(Accounts)] structs
// ---------------------------------------------------------------------------

export interface CreateOrderArgs {
  buyer: PublicKey;
  nonce: bigint;
  amount: bigint;
  listingHash: Uint8Array;
  windowSecs: number;
  /** Defaults to the buyer's associated USDC account. */
  buyerToken?: PublicKey;
  programId?: PublicKey;
}

/** create_order data: disc(8) | nonce u64 | amount u64 | listing_hash [32] | window_secs i64 = 64 bytes. */
export function createOrderIx(a: CreateOrderArgs): TransactionInstruction {
  if (a.amount <= 0n || a.amount > MAX_AMOUNT) throw new Error("Amount out of range.");
  if (a.windowSecs < MIN_WINDOW_SECS || a.windowSecs > MAX_WINDOW_SECS) throw new Error("Window out of range.");
  if (a.listingHash.length !== 32) throw new Error("listingHash must be 32 bytes.");

  const programId = a.programId ?? ORDERS_PROGRAM_ID;
  const [order] = orderPda(a.buyer, a.nonce, programId);
  const [vault] = vaultPda(order, programId);

  const data = Buffer.alloc(64);
  discriminator("create_order").copy(data, 0);
  data.writeBigUInt64LE(a.nonce, 8);
  data.writeBigUInt64LE(a.amount, 16);
  Buffer.from(a.listingHash).copy(data, 24);
  data.writeBigInt64LE(BigInt(a.windowSecs), 56);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: a.buyer, isSigner: true, isWritable: true },
      { pubkey: order, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: a.buyerToken ?? associatedTokenAddress(a.buyer, USDC_MINT), isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** fulfil data: disc(8) | fulfilment_ref [32]. */
export function fulfilIx(a: {
  order: PublicKey;
  buyer: PublicKey;
  fulfilmentRef: Uint8Array;
  operator?: PublicKey;
  operatorToken?: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  if (a.fulfilmentRef.length !== 32) throw new Error("fulfilmentRef must be 32 bytes.");
  const programId = a.programId ?? ORDERS_PROGRAM_ID;
  const operator = a.operator ?? OPERATOR;
  const [vault] = vaultPda(a.order, programId);

  const data = Buffer.alloc(40);
  discriminator("fulfil").copy(data, 0);
  Buffer.from(a.fulfilmentRef).copy(data, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: operator, isSigner: true, isWritable: false },
      { pubkey: a.order, isSigner: false, isWritable: true },
      { pubkey: a.buyer, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: a.operatorToken ?? associatedTokenAddress(operator, USDC_MINT), isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** refund data: disc(8). */
export function refundIx(a: {
  caller: PublicKey;
  order: PublicKey;
  buyer: PublicKey;
  /** Defaults to the buyer's associated USDC account — the only valid destination. */
  buyerToken?: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = a.programId ?? ORDERS_PROGRAM_ID;
  const [vault] = vaultPda(a.order, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: a.caller, isSigner: true, isWritable: false },
      { pubkey: a.order, isSigner: false, isWritable: true },
      { pubkey: a.buyer, isSigner: false, isWritable: true },
      { pubkey: a.buyerToken ?? associatedTokenAddress(a.buyer, USDC_MINT), isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: discriminator("refund"),
  });
}

// ---------------------------------------------------------------------------
// Reading an order
// ---------------------------------------------------------------------------

/** Byte offsets of the Order account, after the 8-byte account discriminator. */
export const ORDER_LAYOUT = {
  buyer: 8,
  nonce: 40,
  amount: 48,
  listingHash: 56,
  createdAt: 88,
  deadline: 96,
  status: 104,
  fulfilmentRef: 105,
  settledAt: 137,
  bump: 145,
  vaultBump: 146,
  size: 147,
} as const;

export const ORDER_ACCOUNT_DISCRIMINATOR = createHash("sha256").update("account:Order").digest().subarray(0, 8);

export interface DecodedOrder {
  buyer: PublicKey;
  nonce: bigint;
  amount: bigint;
  listingHash: Buffer;
  createdAt: number;
  deadline: number;
  status: OrderStatus;
  fulfilmentRef: Buffer;
  settledAt: number;
}

export function decodeOrder(data: Buffer | Uint8Array): DecodedOrder {
  const b = Buffer.from(data);
  if (b.length < ORDER_LAYOUT.size) throw new Error(`Order account too short: ${b.length} bytes`);
  if (!b.subarray(0, 8).equals(ORDER_ACCOUNT_DISCRIMINATOR)) {
    // Without this, any 147-byte account would decode into a plausible order.
    throw new Error("Not a SigPath order account (discriminator mismatch).");
  }
  const statusByte = b.readUInt8(ORDER_LAYOUT.status);
  const status = (Object.keys(ORDER_STATUS) as OrderStatus[]).find((k) => ORDER_STATUS[k] === statusByte);
  if (!status) throw new Error(`Unknown order status ${statusByte}`);
  return {
    buyer: new PublicKey(b.subarray(ORDER_LAYOUT.buyer, ORDER_LAYOUT.buyer + 32)),
    nonce: b.readBigUInt64LE(ORDER_LAYOUT.nonce),
    amount: b.readBigUInt64LE(ORDER_LAYOUT.amount),
    listingHash: b.subarray(ORDER_LAYOUT.listingHash, ORDER_LAYOUT.listingHash + 32),
    createdAt: Number(b.readBigInt64LE(ORDER_LAYOUT.createdAt)),
    deadline: Number(b.readBigInt64LE(ORDER_LAYOUT.deadline)),
    status,
    fulfilmentRef: b.subarray(ORDER_LAYOUT.fulfilmentRef, ORDER_LAYOUT.fulfilmentRef + 32),
    settledAt: Number(b.readBigInt64LE(ORDER_LAYOUT.settledAt)),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** OrdersError, codes 6000.. in declaration order. Keep in step with lib.rs. */
export const ORDERS_ERRORS = [
  "ZeroAmount",
  "AmountTooLarge",
  "WindowOutOfRange",
  "NotFunded",
  "DeadlinePassed",
  "DeadlineNotReached",
  "MissingFulfilmentRef",
  "RefundNotToBuyer",
  "InvalidTokenAccount",
  "WrongMint",
  "NotOperator",
] as const;
export type OrdersErrorName = (typeof ORDERS_ERRORS)[number];

/** The Anchor framework errors these instructions can raise. */
const ANCHOR_ERRORS: Record<number, string> = {
  2001: "ConstraintHasOne",
  2006: "ConstraintSeeds",
  2012: "ConstraintAddress",
};

/**
 * Pull the program error name out of a failed transaction, or null. Reads the
 * "custom program error: 0x…" line the runtime logs, so it works for errors
 * from web3.js, from a wallet, and from simulation alike.
 */
export function ordersErrorName(err: unknown): string | null {
  const text =
    err instanceof Error
      ? `${err.message}\n${((err as { logs?: string[] }).logs ?? []).join("\n")}`
      : String(err);
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (!m) return null;
  const code = parseInt(m[1], 16);
  if (code >= 6000 && code < 6000 + ORDERS_ERRORS.length) return ORDERS_ERRORS[code - 6000];
  return ANCHOR_ERRORS[code] ?? `code ${code}`;
}
