import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { chainStateReader, chainStatusReader, ordersRpcUrl, prepareCheckout } from "@/lib/checkout/checkout";
import { OrderMetaStore } from "@/lib/reports/order-meta";
import { DecisionLog } from "@/lib/reports/reports";
import { AddressStore } from "@/lib/checkout/address-store";

// POST /api/checkout  { quote, buyer, address }
//   -> { transaction (base64, unsigned), order, usdcDisplay, ... }
//
// Builds the transaction the shopper's wallet signs. The browser supplies only
// the signed quote it was handed, its wallet address and a delivery address —
// never an amount, a program or a destination. See lib/checkout/checkout.ts.
//
// NO ADDRESS IN LOGS
// This route logs nothing about the request body. A delivery address in a
// server log is a copy that no deletion ever reaches.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { quote?: unknown; buyer?: unknown; address?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const store = AddressStore.fromEnv();
  const conn = new Connection(ordersRpcUrl(), "confirmed");

  // Housekeeping on every checkout: delete addresses for settled or abandoned
  // orders. Best-effort — a failed sweep must not block a purchase, and the
  // retention cap still applies on the next one.
  if (store) await store.sweep(chainStatusReader(conn)).catch(() => undefined);
  const metaStore = OrderMetaStore.fromEnv();
  if (metaStore) await metaStore.sweep(chainStateReader(conn)).catch(() => undefined);

  const result = await prepareCheckout(
    { quote: body.quote, buyer: body.buyer, address: body.address },
    { store, metaStore, conn, upheldReports: await DecisionLog.fromEnv().upheldCounts() },
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    transaction: result.transaction,
    order: result.order,
    usdcDisplay: result.usdcDisplay,
    windowSecs: result.windowSecs,
    rate: result.rate ? { display: result.rate.display, source: result.rate.source } : null,
  });
}
