import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { NotAnOrderError, ordersRpcUrl, readOrder } from "@/lib/checkout/checkout";
import { AddressStore } from "@/lib/checkout/address-store";

// GET /api/orders/<order>  -> the order's on-chain state
//
// PUBLIC, SO IT RETURNS ONLY WHAT THE CHAIN ALREADY SHOWS
// Order accounts are readable by anyone with the address, so this route adds
// nothing to that: no delivery address, and not even the listing title — the
// chain holds only a hash of what was bought, and publishing the title would
// tell anyone with the order address what this person purchased.
//
// The one extra fact is whether a delivery address is still held, because a
// shopper is entitled to see that it was deleted.

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { order: string } }) {
  let order: PublicKey;
  try {
    order = new PublicKey(params.order);
  } catch {
    return NextResponse.json({ error: "Invalid order address." }, { status: 400 });
  }

  let state;
  try {
    state = await readOrder(new Connection(ordersRpcUrl(), "confirmed"), order);
  } catch (err) {
    if (err instanceof NotAnOrderError) {
      return NextResponse.json({ found: false, error: err.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the order." },
      { status: 502 },
    );
  }
  if (!state.found) return NextResponse.json({ found: false }, { status: 404 });

  const store = AddressStore.fromEnv();
  const addressHeld = store ? (await store.list()).some((r) => r.order === order.toBase58()) : false;

  return NextResponse.json({
    found: true,
    status: state.status,
    amount: state.amount.toString(),
    createdAt: state.createdAt,
    deadline: state.deadline,
    settledAt: state.settledAt,
    buyer: state.buyer.toBase58(),
    addressHeld,
  });
}
