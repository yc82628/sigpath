import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { limited, RULES } from "@/lib/guard/limit";
import { chainStateReader, chainStatusReader, ordersRpcUrl, prepareCartCheckout } from "@/lib/checkout/checkout";
import { AddressStore } from "@/lib/checkout/address-store";
import { OrderMetaStore } from "@/lib/reports/order-meta";
import { DecisionLog } from "@/lib/reports/reports";
import { PaySessionStore, ScanStates } from "@/lib/checkout/pay-session";

// The Solana Pay transaction request a checkout's QR code points at
// (lib/checkout/pay-session.ts; https://docs.solanapay.com/spec):
//
//   GET  /api/pay/<session>              -> { label, icon }   (shown by the wallet before anything else)
//   POST /api/pay/<session> { account }  -> { transaction, message }
//
// The transaction is built exactly as the browser checkout builds it, for the
// wallet that scanned: the session's signed prices and delivery address, one
// escrow order per item. Wallet apps call this from the phone, so it answers
// any origin. NO ADDRESS IN LOGS: nothing about the session is logged.

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Accept-Encoding",
  "Cache-Control": "no-store",
};

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: CORS });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET(req: NextRequest) {
  return reply({ label: "SigPath", icon: `${req.nextUrl.origin}/icons/icon-192.png` });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tooMany = await limited(req.headers, RULES.write);
  if (tooMany) return new NextResponse(tooMany.body, { status: tooMany.status, headers: { ...CORS, "Content-Type": "application/json" } });
  const body = (await req.json().catch(() => null)) as { account?: unknown } | null;
  const store = PaySessionStore.fromEnv();
  if (!store) return reply({ message: "Checkout is not configured." }, 503);
  const scans = ScanStates.fromEnv();

  const session = await store.live(params.id);
  if (!session) {
    const before = await scans.get(params.id).catch(() => null);
    return reply(
      { message: before?.state === "scanned" ? "This code was already used. Show a new one on the checkout page." : "This code has run out. Show a new one on the checkout page." },
      410,
    );
  }

  const conn = new Connection(ordersRpcUrl(), "confirmed");
  const addresses = AddressStore.fromEnv();
  const metaStore = OrderMetaStore.fromEnv();
  // Housekeeping, as on every checkout: best-effort, never blocks a purchase.
  if (addresses) await addresses.sweep(chainStatusReader(conn)).catch(() => undefined);
  if (metaStore) await metaStore.sweep(chainStateReader(conn)).catch(() => undefined);

  const result = await prepareCartCheckout(
    { quotes: session.quotes, buyer: body?.account, address: session.address },
    { store: addresses, metaStore, conn, upheldReports: await DecisionLog.fromEnv().upheldCounts() },
  );
  if (!result.ok) {
    // The page shows why (a short balance, a price run out); the session stays, so the same code can be scanned again.
    await scans.set(params.id, { state: "failed", message: result.error, ...(result.shortfallUsdc ? { shortfallUsdc: result.shortfallUsdc } : {}) }).catch(() => undefined);
    return reply({ message: result.error }, result.status);
  }

  await scans
    .set(params.id, {
      state: "scanned",
      orders: result.orders.map((o) => ({ order: o.order, source: o.listing.source, id: o.listing.id, title: o.listing.title })),
      validUntil: result.validUntil,
      buyer: String(body?.account),
    })
    .catch(() => undefined);
  // The orders hold the address now, as every order's: the session's copy goes.
  await store.delete(params.id).catch(() => undefined);

  const items = result.orders.length;
  return reply({
    transaction: result.transaction,
    message: `SigPath: ${items} ${items === 1 ? "item" : "items"}, ${result.totalDisplay}, held in escrow until fulfilled`,
  });
}
