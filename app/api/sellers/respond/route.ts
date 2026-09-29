import { NextRequest, NextResponse } from "next/server";
import { respondAsSeller } from "@/lib/reports/seller";
import { DecisionLog } from "@/lib/reports/reports";
import { CaseLog } from "@/lib/reports/cases";

// POST /api/sellers/respond  { token, order, text }  -> { kind: "reply" | "appeal" }
//
// A reply before a decision (the reviewer reads it first, and it ends the
// waiting period), or an appeal after an upheld one (asks for a reversal).
// One of each per report, write-once, published beside the finding.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { token?: unknown; order?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const r = await respondAsSeller(
    { token: body.token, order: body.order, text: body.text },
    { decisions: DecisionLog.fromEnv(), cases: CaseLog.fromEnv() },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ kind: r.kind });
}
