import { NextRequest, NextResponse } from "next/server";
import { businessRecord } from "@/lib/api/verification";
import { apiDepsFromEnv } from "@/lib/api/deps";
import { refuseUnpaid } from "@/lib/api/gate";

// GET /api/v1/business?vatCountry=DE&vatNumber=123456789 | ?domain=example.de | ?id=b_...
// A verified business: status, evidence and linked accounts. `found: false`
// when SigPath has no record (not a warning on its own). Paid per request.

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = refuseUnpaid(req);
  if (refused) return refused;
  const p = req.nextUrl.searchParams;
  const r = await businessRecord(
    { id: p.get("id") ?? undefined, vatCountry: p.get("vatCountry") ?? undefined, vatNumber: p.get("vatNumber") ?? undefined, domain: p.get("domain") ?? undefined },
    apiDepsFromEnv(),
  );
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
