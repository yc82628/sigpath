import { NextResponse } from "next/server";
import { PaySessionStore, ScanStates } from "@/lib/checkout/pay-session";

// GET /api/pay/<session>/status
//   -> { state: "waiting" }                         the code hasn't been scanned yet
//    | { state: "scanned", orders, validUntil }      a phone took the transaction: follow it (/api/checkout/status)
//    | { state: "failed", message, shortfallUsdc? }  the scan couldn't build it (the code still works)
//    | { state: "gone" }                             run out, or never existed
//
// What the checkout page asks every two seconds while its QR code is shown.
// Nothing about the address or the buyer: only what the scan did.

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const headers = { "Cache-Control": "no-store" };
  const store = PaySessionStore.fromEnv();
  const scan = await ScanStates.fromEnv()
    .get(params.id)
    .catch(() => null);
  if (scan?.state === "scanned") return NextResponse.json({ state: "scanned", orders: scan.orders, validUntil: scan.validUntil }, { headers });
  const live = store ? await store.live(params.id) : null;
  if (!live) return NextResponse.json({ state: "gone" }, { headers });
  if (scan?.state === "failed") return NextResponse.json(scan, { headers });
  return NextResponse.json({ state: "waiting" }, { headers });
}
