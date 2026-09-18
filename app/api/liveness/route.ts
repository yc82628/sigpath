import { NextRequest, NextResponse } from "next/server";
import { getLivenessProvider } from "@/lib/liveness";
import { VisionLivenessProvider, getPublicChallenge } from "@/lib/liveness/vision";
import { issueNonce, recordLiveness } from "@/lib/liveness/store";
import { bytesToHex } from "@/lib/crypto/hash";
import type { RiskBand } from "@/lib/liveness/injection";

// POST /api/liveness
//   { action: "create" }
//     -> { sessionId, instruction, expiresAt, ttlSeconds, nonceHex }
//   { action: "complete", sessionId, imageBase64, mediaType, risk? }
//     -> { passed, confidence, reason }
//
// THE TRUST BOUNDARY
// The browser never asserts that it passed. It sends an image; the server judges
// it and records the outcome in lib/liveness/store.ts. /api/attest later reads
// that record to decide whether to set the on-chain LIVE_CAPTURE flag. A client
// that POSTs {passed: true} gets nowhere, because no route reads `passed` from a
// request body.
//
// THE DEADLINE IS ENFORCED HERE, NOT IN THE UI
// The countdown the user sees is a courtesy. VisionLivenessProvider.verify()
// re-checks the challenge's expiry server-side on every submission, so a
// modified client that hides or extends the timer changes nothing.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    sessionId?: string;
    imageBase64?: string;
    mediaType?: string;
    /** Client-side injection heuristics. ADVISORY ONLY — see below. */
    risk?: RiskBand;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const provider = getLivenessProvider();

  // --- create ---------------------------------------------------------------
  if (body.action === "create") {
    const session = await provider.createSession("anon");
    const nonce = issueNonce(session.sessionId);
    const pub = getPublicChallenge(session.sessionId);

    return NextResponse.json({
      sessionId: session.sessionId,
      // `clientToken` carries the instruction for the vision provider; the mock
      // returns a placeholder, which is correct — the mock has no challenge.
      instruction: pub?.instruction ?? session.clientToken ?? "",
      expiresAt: pub?.expiresAt ?? null,
      ttlSeconds: pub?.ttlSeconds ?? null,
      // The capture binds this into its signature, proving the photo was taken
      // after the challenge was issued rather than prepared earlier.
      nonceHex: bytesToHex(nonce),
      provider: provider.name,
    });
  }

  // --- complete -------------------------------------------------------------
  if (body.action === "complete") {
    if (!body.sessionId) {
      return NextResponse.json({ error: "sessionId required." }, { status: 400 });
    }

    const payload = { imageBase64: body.imageBase64, mediaType: body.mediaType };

    // The vision provider exposes a richer result that distinguishes "failed the
    // check" from "the check could not run". Use it when present; fall back to
    // the plain interface for any other provider.
    if (provider instanceof VisionLivenessProvider) {
      const v = await provider.verify(body.sessionId, payload);

      if (v.unavailable) {
        // NOT a failure of the user. Record nothing — recording passed:false here
        // would burn their attempt because our API was down.
        return NextResponse.json(
          { error: "Verification unavailable.", detail: v.unavailable },
          { status: 503 },
        );
      }

      recordLiveness(body.sessionId, v.passed, v.confidence);

      // OPERATOR AUDIT TRAIL. `observed` is the model's transcription of what was
      // actually in frame, and it is the only way to answer "why did this pass?"
      // after the fact. Without it a disputed verdict is unreviewable, and during
      // testing there is no way to tell a handwritten capture from a photographed
      // screen — both just log 200.
      //
      // Server-side only. Returning it to the client would tell an attacker
      // exactly what the model saw and what to change on the next attempt.
      console.log(
        `[liveness] ${body.sessionId.slice(0, 8)} ${v.passed ? "PASS" : "FAIL"} ` +
          `conf=${v.confidence.toFixed(2)} observed="${v.observed.replace(/\s+/g, " ").slice(0, 300)}"` +
          (v.failureReason ? ` reason="${v.failureReason.slice(0, 200)}"` : ""),
      );

      return NextResponse.json({
        passed: v.passed,
        confidence: v.confidence,
        // Deliberately NOT returning `observed`. It is the audit trail for an
        // operator; handing it back tells an attacker exactly what the model saw
        // and what to change on the next attempt.
        reason: v.passed ? "" : v.failureReason,
      });
    }

    const result = await provider.getResult(body.sessionId, payload);
    recordLiveness(body.sessionId, result.passed, result.score, result.faceTemplate);
    return NextResponse.json({
      passed: result.passed,
      confidence: result.score,
      reason: result.passed ? "" : "Check did not pass.",
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
