import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { limited, RULES } from "@/lib/guard/limit";
import { chainStateReader, chainStatusReader, ordersRpcUrl, prepareCartCheckout } from "@/lib/checkout/checkout";
import { OrderMetaStore } from "@/lib/reports/order-meta";
import { DecisionLog } from "@/lib/reports/reports";
import { AddressStore } from "@/lib/checkout/address-store";

// POST /api/checkout/cart  { quotes: string[], buyer, address }
//   -> { transaction (base64, unsigned), orders: [{ order, usdcDisplay, ... }], totalDisplay }
//
// The cart's checkout: one transaction holding one escrow order per item, so
// the shopper approves once and each order is still protected, refunded and
// reported on its own. Same rules as /api/checkout, item by item; the browser
// sends only signed quotes, its wallet address and one delivery address.
//
// NO ADDRESS IN LOGS: this route logs nothing about the request body.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.write);
  if (tooMany) return tooMany;
  let body: { quotes?: unknown; buyer?: unknown; address?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const store = AddressStore.fromEnv();
  const conn = new Connection(ordersRpcUrl(), "confirmed");
  // Housekeeping, as on every checkout: best-effort, never blocks a purchase.
  if (store) await store.sweep(chainStatusReader(conn)).catch(() => undefined);
  const metaStore = OrderMetaStore.fromEnv();
  if (metaStore) await metaStore.sweep(chainStateReader(conn)).catch(() => undefined);

  const result = await prepareCartCheckout(
    { quotes: body.quotes, buyer: body.buyer, address: body.address },
    { store, metaStore, conn, upheldReports: await DecisionLog.fromEnv().upheldCounts() },
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.shortfallUsdc ? { shortfallUsdc: result.shortfallUsdc } : {}) },
      { status: result.status },
    );
  }
  return NextResponse.json({
    transaction: result.transaction,
    orders: result.orders.map((o) => ({ order: o.order, usdcDisplay: o.usdcDisplay, source: o.listing.source, id: o.listing.id, title: o.listing.title })),
    totalDisplay: result.totalDisplay,
    windowSecs: result.windowSecs,
  });
}
