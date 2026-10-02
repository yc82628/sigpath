import { NextRequest, NextResponse } from "next/server";
import { proveHandle } from "@/lib/sellers/claim";
import { listingLookup } from "@/lib/sellers/badges";
import { VerifiedSellerLog } from "@/lib/sellers/verified-log";
import { DecisionLog } from "@/lib/reports/reports";

// POST /api/sellers/claim/prove  { claimToken, source, listingId }
//   -> { provenToken, sellerKey, message }
//
// Step 2 of 4. Reads the listing through the marketplace's own API and checks
// the code is in it. The handle comes from the marketplace's answer — the
// claimant never types it. Returns the message their wallet must sign.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const decisions = DecisionLog.fromEnv();
  const r = await proveHandle(
    { claimToken: body.claimToken, source: body.source, listingId: body.listingId },
    { lookup: listingLookup(), log: VerifiedSellerLog.fromEnv(), upheldCounts: () => decisions.upheldCounts() },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ provenToken: r.provenToken, sellerKey: r.sellerKey, message: r.message });
}
