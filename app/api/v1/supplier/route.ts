import { NextRequest, NextResponse } from "next/server";
import { checkSupplier } from "@/lib/suppliers/check";
import { BusinessLog } from "@/lib/sellers/business";
import { VerifiedSellerLog } from "@/lib/sellers/verified-log";
import { DecisionLog } from "@/lib/reports/reports";
import { refuseUnpaid } from "@/lib/api/gate";
import { API_MARKETPLACES } from "@/lib/api/verification";

// POST /api/v1/supplier  { vatCountry?, vatNumber?, name?, domain?, marketplace?, handle? }
// The supplier check from /suppliers: VAT register, name, website age and
// SigPath's records. POST, so supplier details never sit in a URL or a gateway
// log. Nothing is stored. Paid per request; see /developers.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const refused = refuseUnpaid(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string).slice(0, 200) : undefined);
  const marketplace = str("marketplace")?.trim().toLowerCase();
  if (marketplace && !(API_MARKETPLACES as readonly string[]).includes(marketplace)) {
    return NextResponse.json({ error: `marketplace must be one of ${API_MARKETPLACES.join(", ")}.` }, { status: 400 });
  }
  const r = await checkSupplier(
    { vatCountry: str("vatCountry"), vatNumber: str("vatNumber"), name: str("name"), domain: str("domain"), marketplace: str("marketplace"), handle: str("handle") },
    { businesses: () => BusinessLog.fromEnv().all(), badges: () => VerifiedSellerLog.fromEnv().all(), upheld: () => DecisionLog.fromEnv().upheldCounts() },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ...r.report, checkedAt: new Date(r.report.checkedAt).toISOString() });
}
