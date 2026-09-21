import { NextRequest, NextResponse } from "next/server";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { collectGithub } from "@/lib/footprint/github";
import { computeFootprintScore } from "@/lib/footprint/score";
import { subjectHash, bytesToHex } from "@/lib/crypto/hash";
import { issueIx, METHOD } from "@/lib/chains/solana/instructions";
import { attestationPda } from "@/lib/chains/solana/pda";
import { consumeLiveness } from "@/lib/liveness/store";
import { issueSasAttestation } from "@/lib/chains/solana/sas";
import { SOLANA_RPC_URL, SOLANA_PROGRAM_ID, ATTESTATION_TTL_SECONDS } from "@/lib/config";

// POST /api/attest  { platform: "github", handle: "alice" }
//
// Runs the footprint check, then records the result on Solana so the outcome is
// independently checkable. The response carries everything needed to verify it
// WITHOUT trusting this server: the subject hash, the account address, and the
// explorer links.
//
// THE POINT OF WRITING IT ON CHAIN
// A score returned by an API is only as trustworthy as the API. A score written
// to a public account can be re-derived by anyone: hash the handle, derive the
// PDA, read the record. That is what makes "verified" a claim a third party can
// check rather than one they have to accept.

export const runtime = "nodejs";

function issuerKeypair(): Keypair {
  const raw = process.env.ISSUER_SECRET;
  if (!raw) throw new Error("ISSUER_SECRET is not set.");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * Translate the scorer's evidence into the on-chain method bitfield, so a
 * verifier can see HOW a score was reached and weigh it, instead of taking the
 * number on trust.
 */
function methodFlags(
  reports: Awaited<ReturnType<typeof computeFootprintScore>>["reports"],
  liveCapture: boolean,
): number {
  let flags = 0;
  if (liveCapture) flags |= METHOD.LIVE_CAPTURE;
  for (const r of reports) {
    if (r.ownershipProven) flags |= METHOD.OWNERSHIP_PROVEN;
    for (const s of r.signals) {
      if (s.kind === "corroborated" && s.normalised > 0) flags |= METHOD.CORROBORATED;
      if (s.kind === "self_asserted") flags |= METHOD.SELF_ASSERTED;
    }
  }
  return flags;
}

export async function POST(req: NextRequest) {
  let body: {
    platform?: string;
    handle?: string;
    ownershipProven?: boolean;
    /** From POST /api/liveness — set only after the capture challenge passed. */
    livenessSessionId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const handle = (body.handle ?? "").trim().replace(/^@/, "");
  if (body.platform !== "github" || !handle) {
    return NextResponse.json(
      { error: "Supply { platform: 'github', handle: '...' }." },
      { status: 400 },
    );
  }

  // --- 1. gather evidence ---------------------------------------------------
  // NOTE: ownership defaults to false. An unproven account scores 0 by design —
  // anyone can type someone else's handle into a form. Pass ownershipProven only
  // after the nonce-publish check in lib/footprint/ownership.ts has passed.
  const report = await collectGithub(handle, body.ownershipProven === true);

  if (report.status !== "ok") {
    // "Could not check" is not "failed". Say which it was, and issue nothing.
    return NextResponse.json(
      {
        error: "Evidence could not be gathered; no attestation issued.",
        status: report.status,
        detail: report.detail,
      },
      { status: report.status === "rate_limited" ? 503 : 400 },
    );
  }

  const scored = computeFootprintScore([report]);

  // --- 1b. live capture, if one was completed -------------------------------
  // THE CLIENT NEVER ASSERTS THIS. It supplies a session id; the server looks up
  // what it recorded when the capture challenge was judged. A forged id is not
  // found, so passing `livenessSessionId: "anything"` buys nothing.
  //
  // The session is CONSUMED here — single use. Otherwise one successful capture
  // could stamp LIVE_CAPTURE onto any number of unrelated attestations.
  // consumeLiveness returns null unless the session exists, passed, is unexpired
  // and is unused — so a non-null result IS the pass signal. Do not add a
  // `.passed` check on top; the type has no such field and the store has already
  // applied every condition.
  const liveCapture = body.livenessSessionId
    ? consumeLiveness(body.livenessSessionId) !== null
    : false;

  // --- 2. record it on chain ------------------------------------------------
  const subject = await subjectHash("github", handle);
  const programId = new PublicKey(SOLANA_PROGRAM_ID);
  const [pda] = attestationPda(programId, subject);
  const conn = new Connection(SOLANA_RPC_URL, "confirmed");

  let signature: string;
  try {
    const issuer = issuerKeypair();
    const ix = issueIx({
      programId,
      issuer: issuer.publicKey,
      subjectHash: subject,
      score: scored.score,
      method: methodFlags(scored.reports, liveCapture),
      ttlSeconds: ATTESTATION_TTL_SECONDS,
    });
    signature = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [issuer], {
      commitment: "confirmed",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    // A PDA can only be created once per subject. Re-attesting the same handle
    // hits this, and it is not a verification failure — say so precisely.
    const already = message.includes("already in use");
    return NextResponse.json(
      {
        error: already
          ? "An attestation already exists for this subject. Revoke it before re-issuing."
          : "On-chain write failed; the score was computed but not recorded.",
        detail: message,
        score: scored.score,
        band: scored.band,
      },
      { status: already ? 409 : 502 },
    );
  }

  // --- 3. issue into Solana Attestation Service ------------------------------
  // SigPath's own program is the detailed record; SAS is the portable one, so a
  // lending protocol or DAO gate can act on this verification without knowing
  // SigPath exists. Runs AFTER the SigPath write and never blocks it — a SAS
  // failure is operational, not a verification failure.
  const expiresAt = Math.floor(Date.now() / 1000) + ATTESTATION_TTL_SECONDS;
  const sas = await issueSasAttestation(
    subject,
    scored.score,
    methodFlags(scored.reports, liveCapture),
    expiresAt,
  );

  const cluster = SOLANA_RPC_URL.includes("devnet")
    ? "?cluster=devnet"
    : SOLANA_RPC_URL.includes("127.0.0.1") || SOLANA_RPC_URL.includes("localhost")
      ? "?cluster=custom"
      : "";

  return NextResponse.json({
    score: scored.score,
    band: scored.band,
    liveCapture,
    reasons: scored.reasons,
    gaps: scored.gaps,
    signals: report.signals.map((s) => ({
      label: s.label,
      value: s.value,
      kind: s.kind,
      weight: s.weight,
    })),
    // Everything below lets a third party check this without trusting us.
    proof: {
      subject: `github:${handle}`,
      subjectHash: bytesToHex(subject),
      account: pda.toBase58(),
      program: programId.toBase58(),
      signature,
      explorerAccount: `https://explorer.solana.com/address/${pda.toBase58()}${cluster}`,
      explorerTx: `https://explorer.solana.com/tx/${signature}${cluster}`,
      // Portable credential. `disabled` means SAS_ENABLED is not set — the
      // SigPath attestation above is unaffected either way.
      sas:
        sas.status === "ok"
          ? { status: "ok", account: sas.attestation, signature: sas.signature, explorer: sas.explorer }
          : { status: sas.status, reason: sas.reason },
    },
  });
}
