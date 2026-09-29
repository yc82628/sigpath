import { NextRequest, NextResponse } from "next/server";
import { createReportIntent } from "@/lib/reports/reports";
import { reportDepsFromEnv } from "@/lib/reports/evidence";

// POST /api/reports/intent  { order, wallet }  -> { intentId, message }
//
// Step 1 of 3. Checks the order can be reported — paid, fulfilled, within the
// window, not already reported, and that this wallet is the one that paid —
// and returns the exact text the wallet must sign to prove it.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { order?: unknown; wallet?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const deps = reportDepsFromEnv();
  if (!deps) return NextResponse.json({ error: "Reporting is not configured (ADDRESS_KEY)." }, { status: 503 });

  const r = await createReportIntent({ order: body.order, wallet: body.wallet }, deps);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ intentId: r.intentId, message: r.message });
}
