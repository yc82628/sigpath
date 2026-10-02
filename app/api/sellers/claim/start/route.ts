import { NextRequest, NextResponse } from "next/server";
import { startClaim } from "@/lib/sellers/claim";

// POST /api/sellers/claim/start  { wallet }
//   -> { claimToken, code, expiresAt }
//
// Step 1 of 4. Issues the one-time code the seller puts into one of their
// listings. Stores nothing: the code and wallet live in the signed token.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { wallet?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const r = startClaim({ wallet: body.wallet });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ claimToken: r.claimToken, code: r.code, expiresAt: r.expiresAt });
}
