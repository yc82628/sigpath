/**
 * lib/checkout/operator.ts — what the operator does after a shopper pays.
 *
 * Kept out of the admin script so the end-to-end test exercises exactly the
 * code the operator runs, rather than a copy of it.
 *
 * THE DELETE COMES AFTER THE CHAIN, NEVER BEFORE
 * An address is deleted only once the fulfil (or refund) transaction has
 * CONFIRMED. Deleting first and then failing to settle would leave a paid
 * order with nowhere to ship it; settling and then failing to delete is caught
 * by the next sweep, and by the retention cap in any case.
 */

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as orders from "../chains/solana/orders";
import type { AddressStore } from "./address-store";

export interface SettleResult {
  signature: string;
  addressDeleted: boolean;
}

function assertOperator(kp: Keypair) {
  if (!kp.publicKey.equals(orders.OPERATOR)) {
    throw new Error(`This key is ${kp.publicKey.toBase58()}, not the program's operator ${orders.OPERATOR.toBase58()}.`);
  }
}

export async function fulfilOrder(
  conn: Connection,
  operator: Keypair,
  order: PublicKey,
  retailerReference: string,
  store: AddressStore,
): Promise<SettleResult> {
  assertOperator(operator);
  const info = await conn.getAccountInfo(order, "confirmed");
  if (!info) throw new Error("No such order on chain.");
  const state = orders.decodeOrder(info.data);

  const signature = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      orders.fulfilIx({
        order,
        buyer: state.buyer,
        fulfilmentRef: orders.fulfilmentRefHash(retailerReference),
      }),
    ),
    [operator],
    { commitment: "confirmed" },
  );
  // Confirmed. The item has been bought and paid for; the address has served
  // its only purpose.
  return { signature, addressDeleted: await store.delete(order.toBase58()) };
}

/** Operator refunds early — item unavailable, price changed. */
export async function refundOrderAsOperator(
  conn: Connection,
  operator: Keypair,
  order: PublicKey,
  store: AddressStore,
): Promise<SettleResult> {
  assertOperator(operator);
  const info = await conn.getAccountInfo(order, "confirmed");
  if (!info) throw new Error("No such order on chain.");
  const state = orders.decodeOrder(info.data);

  const signature = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(orders.refundIx({ caller: operator.publicKey, order, buyer: state.buyer })),
    [operator],
    { commitment: "confirmed" },
  );
  return { signature, addressDeleted: await store.delete(order.toBase58()) };
}
