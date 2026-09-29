import { NextRequest, NextResponse } from "next/server";
import { submitReport } from "@/lib/reports/reports";
import { evidenceProvider, reportDepsFromEnv } from "@/lib/reports/evidence";

// POST /api/reports
//   { intentId, sessionId, imageBase64, mediaType, category, description }
//   -> { passed: true } | { passed: false, reason }
//
// Step 3 of 3. Judges the live photo and, if it passes, files the report for
// review — encrypted, and visible to nobody but the reviewer. Nothing about the
// seller changes until a reviewer upholds it.
//
// NOTHING FROM THE BODY IS LOGGED. The photo, the description and the wallet
// are personal data; a log line is a copy no deletion reaches.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const deps = reportDepsFromEnv();
  if (!deps) return NextResponse.json({ error: "Reporting is not configured (ADDRESS_KEY)." }, { status: 503 });

  const r = await submitReport(
    {
      intentId: body.intentId,
      sessionId: body.sessionId,
      imageBase64: body.imageBase64,
      mediaType: body.mediaType,
      category: body.category,
      description: body.description,
    },
    { ...deps, verify: (sessionId, payload) => evidenceProvider().verify(sessionId, payload) },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r.passed ? { passed: true } : { passed: false, reason: r.reason });
}
