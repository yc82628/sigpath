import { NextRequest, NextResponse } from "next/server";
import { completeClaim } from "@/lib/sellers/claim";
import { badgeIssuer, claimProvider } from "@/lib/sellers/badges";
import { VerifiedSellerLog } from "@/lib/sellers/verified-log";
import { DecisionLog } from "@/lib/reports/reports";

// POST /api/sellers/claim/complete  { provenToken, sessionId, imageBase64, mediaType }
//   -> { passed: true, sellerKey, attestation, mint, expiresAt } | { passed: false, reason }
//
// Step 4 of 4. Judges the live photo and, if it passes, issues the
// verified-seller token to the claimant's wallet.
//
// NOTHING FROM THE BODY IS LOGGED, and the frame is not stored: it is checked
// and discarded. No biometric data is kept.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const decisions = DecisionLog.fromEnv();
  const r = await completeClaim(
    { provenToken: body.provenToken, sessionId: body.sessionId, imageBase64: body.imageBase64, mediaType: body.mediaType },
    {
      log: VerifiedSellerLog.fromEnv(),
      upheldCounts: () => decisions.upheldCounts(),
      verify: (sessionId, payload) => claimProvider().verify(sessionId, payload),
      issue: badgeIssuer(),
    },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  if (!r.passed) return NextResponse.json({ passed: false, reason: r.reason });
  return NextResponse.json({
    passed: true,
    sellerKey: r.sellerKey,
    attestation: r.badge.attestation,
    mint: r.badge.mint,
    expiresAt: r.badge.expiresAt,
  });
}
