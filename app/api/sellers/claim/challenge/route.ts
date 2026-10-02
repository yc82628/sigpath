import { NextRequest, NextResponse } from "next/server";
import { bindClaimSession, verifyClaimSignature } from "@/lib/sellers/claim";
import { claimProvider } from "@/lib/sellers/badges";
import { getPublicChallenge } from "@/lib/liveness/vision";

// POST /api/sellers/claim/challenge  { provenToken, signature }
//   -> { sessionId, instruction, expiresAt, ttlSeconds }
//
// Step 3 of 4. Checks the wallet's signature over the claim message, and only
// then issues the camera challenge — bound to this claim, so no other capture
// can be submitted in its place.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { provenToken?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const sig = verifyClaimSignature({ provenToken: body.provenToken, signature: body.signature });
  if (!sig.ok) return NextResponse.json({ error: sig.error }, { status: sig.status });

  const session = await claimProvider().createSession("seller-claim");
  bindClaimSession(String(body.provenToken), session.sessionId);
  const pub = getPublicChallenge(session.sessionId);
  return NextResponse.json({
    sessionId: session.sessionId,
    instruction: pub?.instruction ?? session.clientToken,
    expiresAt: pub?.expiresAt,
    ttlSeconds: pub?.ttlSeconds,
  });
}
