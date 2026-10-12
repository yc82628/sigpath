import { NextRequest, NextResponse } from "next/server";
import { sellerRecord } from "@/lib/api/verification";
import { apiDepsFromEnv } from "@/lib/api/deps";
import { refuseUnpaidOrLimited } from "@/lib/api/gate";
import { RULES } from "@/lib/guard/limit";

// GET /api/v1/seller?marketplace=ebay&handle=<seller>
// Verified seller (cross-checked on Solana), the business behind it, and upheld
// fake-product findings. Paid per request through pay.sh; see /developers.

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = await refuseUnpaidOrLimited(req, RULES.search);
  if (refused) return refused;
  const p = req.nextUrl.searchParams;
  const r = await sellerRecord({ marketplace: p.get("marketplace") ?? "", handle: p.get("handle") ?? "" }, apiDepsFromEnv());
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
