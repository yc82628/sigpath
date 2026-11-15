/**
 * lib/account/orders.ts — the escrow orders one wallet paid for, from the chain.
 *
 * Every order account records the wallet that paid (the buyer, at a fixed
 * offset), so one filtered read finds them all, on any device, with nothing
 * stored by SigPath. What comes back is what the chain already shows anyone:
 * status, amount and dates. The item stays a hash, as on the order page.
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import { getBase58Decoder } from "@solana/kit";
import { decodeOrder, ORDER_ACCOUNT_DISCRIMINATOR, ORDER_LAYOUT, ORDERS_PROGRAM_ID, type OrderStatus } from "../chains/solana/orders";

export interface WalletOrder {
  /** The order account's address: its page is /order/<address>. */
  address: string;
  status: OrderStatus;
  /** USDC base units. */
  amount: bigint;
  createdAt: number;
  deadline: number;
  settledAt: number;
}

/** The filters for one buyer's orders: SigPath order accounts whose buyer field is this wallet. */
export function buyerFilters(buyer: PublicKey) {
  return [
    { dataSize: ORDER_LAYOUT.size },
    { memcmp: { offset: 0, bytes: getBase58Decoder().decode(ORDER_ACCOUNT_DISCRIMINATOR) } },
    { memcmp: { offset: ORDER_LAYOUT.buyer, bytes: buyer.toBase58() } },
  ];
}

/** Newest first. Accounts that don't decode, or name another buyer, are skipped. */
export async function ordersForBuyer(conn: Pick<Connection, "getProgramAccounts">, buyer: PublicKey): Promise<WalletOrder[]> {
  const accounts = await conn.getProgramAccounts(ORDERS_PROGRAM_ID, { commitment: "confirmed", filters: buyerFilters(buyer) });
  const out: WalletOrder[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const o = decodeOrder(account.data);
      if (!o.buyer.equals(buyer)) continue;
      out.push({ address: pubkey.toBase58(), status: o.status, amount: o.amount, createdAt: o.createdAt, deadline: o.deadline, settledAt: o.settledAt });
    } catch {
      /* not an order after all */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** An order whose deadline has passed unfulfilled: the refund is open to the buyer. */
export function refundOpen(o: Pick<WalletOrder, "status" | "deadline">, nowS = Math.floor(Date.now() / 1000)): boolean {
  return o.status === "funded" && nowS > o.deadline;
}
