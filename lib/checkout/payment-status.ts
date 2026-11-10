/**
 * lib/checkout/payment-status.ts — what became of a payment the wallet sent.
 *
 * WHY
 * The wallet signs and sends the transaction itself, so the site learns only
 * "sent". Then: did it land? A wallet set to Mainnet sends a devnet payment to
 * the wrong network, where it can never land; a slow approval lets the
 * transaction's blockhash run out; the program can refuse it. Watching only for
 * the order to appear can't tell any of these from "still confirming", and a
 * shopper left on "reload in a moment" either waits forever or pays again.
 *
 * HOW
 * Three facts from SigPath's own network, read in this order:
 *   1. the block height now,
 *   2. whether the order account exists (the payment created it),
 *   3. the transaction's status, by its signature, when the wallet gave one.
 * The order is the proof of payment. A transaction the network rejected is
 * "failed". With neither, once the block height has passed the transaction's
 * last valid block height, it can never land: "expired", nothing was charged,
 * and paying again is safe. Reading the height FIRST makes that sound: a
 * transaction that landed before the height was read shows up in step 2.
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import { NotAnOrderError, readOrder } from "./checkout";

export type PaymentState = "paid" | "failed" | "expired" | "pending";

export interface PaymentStatus {
  state: PaymentState;
  /** For "failed": the network's reason, as it gave it. */
  reason?: string;
}

/** The network's error, short enough to show. */
function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err).slice(0, 160);
  } catch {
    return "rejected";
  }
}

/** Decide from what the network said. Pure, so every case is tested. */
export function decidePayment(x: {
  orderFound: boolean;
  /** The transaction's status, or null when the network hasn't seen it (or there was no signature). */
  signature: { err: unknown } | null;
  blockHeight: number;
  /** The transaction's last valid block height, from the checkout; null if unknown. */
  validUntil: number | null;
}): PaymentStatus {
  if (x.orderFound) return { state: "paid" };
  if (x.signature?.err) return { state: "failed", reason: errorText(x.signature.err) };
  // Seen without an error: landed, and the order is a moment from being readable.
  if (x.signature) return { state: "pending" };
  if (x.validUntil !== null && x.blockHeight > x.validUntil) return { state: "expired" };
  return { state: "pending" };
}

/** Ask the network. `signature` is base58; `validUntil` the checkout's last valid block height. */
export async function readPayment(
  conn: Connection,
  input: { order: PublicKey; signature: string | null; validUntil: number | null },
): Promise<PaymentStatus> {
  const blockHeight = await conn.getBlockHeight("confirmed");
  const [order, statuses] = await Promise.all([
    readOrder(conn, input.order).catch((err) => {
      if (err instanceof NotAnOrderError) return { found: false as const };
      throw err;
    }),
    input.signature ? conn.getSignatureStatuses([input.signature], { searchTransactionHistory: true }) : Promise.resolve(null),
  ]);
  const s = statuses?.value[0] ?? null;
  return decidePayment({ orderFound: order.found, signature: s ? { err: s.err } : null, blockHeight, validUntil: input.validUntil });
}
