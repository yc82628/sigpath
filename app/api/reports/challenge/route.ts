import { NextRequest, NextResponse } from "next/server";
import { bindEvidenceSession, verifyIntentSignature } from "@/lib/reports/reports";
import { evidenceProvider } from "@/lib/reports/evidence";
import { getPublicChallenge } from "@/lib/liveness/vision";

// POST /api/reports/challenge  { intentId, signature }
//   -> { sessionId, instruction, expiresAt, ttlSeconds }
//
// Step 2 of 3. Verifies the wallet's signature, and only then issues the
// evidence challenge — so the 90-second window starts when the camera does,
// not while the buyer is reading a wallet prompt. The session is bound to this
// intent: no other capture can be submitted in its place.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { intentId?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const intentId = String(body.intentId ?? "");

  const sig = verifyIntentSignature(intentId, body.signature);
  if (!sig.ok) return NextResponse.json({ error: sig.error }, { status: sig.status });

  const session = await evidenceProvider().createSession("report");
  const bound = bindEvidenceSession(intentId, session.sessionId);
  if (!bound.ok) return NextResponse.json({ error: bound.error }, { status: bound.status });

  const pub = getPublicChallenge(session.sessionId);
  return NextResponse.json({
    sessionId: session.sessionId,
    instruction: pub?.instruction ?? session.clientToken,
    expiresAt: pub?.expiresAt,
    ttlSeconds: pub?.ttlSeconds,
  });
}
