import { NextRequest, NextResponse } from "next/server";
import { verifySellerToken } from "@/lib/reports/seller-access";
import { sellerFindings } from "@/lib/reports/seller";
import { DecisionLog, ReportStore } from "@/lib/reports/reports";
import { CaseLog } from "@/lib/reports/cases";

// POST /api/sellers/findings  { token }  -> { seller, findings }
//
// Everything reported about the seller the link was issued to — pending
// reports included, because a right of reply is empty for a report you cannot
// read. POST, not GET, so the token travels in a body rather than a URL that
// would end up in logs and browser history.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const auth = verifySellerToken(body.token);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const reportStore = ReportStore.fromEnv();
  if (!reportStore) return NextResponse.json({ error: "Reports are not configured." }, { status: 503 });

  const findings = await sellerFindings(auth.sellerKey, {
    reportStore,
    decisions: DecisionLog.fromEnv(),
    cases: CaseLog.fromEnv(),
  });
  return NextResponse.json({ seller: auth.sellerKey, findings });
}
