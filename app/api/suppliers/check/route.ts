import { NextRequest, NextResponse } from "next/server";
import { checkSupplier } from "@/lib/suppliers/check";
import { BusinessLog } from "@/lib/sellers/business";
import { VerifiedSellerLog } from "@/lib/sellers/verified-log";
import { DecisionLog } from "@/lib/reports/reports";
import { limited, RULES } from "@/lib/guard/limit";

// POST /api/suppliers/check  { vatCountry?, vatNumber?, name?, domain?, marketplace?, handle? }
//
// Checks a supplier against the EU VAT register, its domain's registry and
// SigPath's own records. Nothing is stored and nothing is logged: the inputs
// are only used to ask those sources.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.supplier);
  if (tooMany) return tooMany;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string).slice(0, 200) : undefined);
  const result = await checkSupplier(
    { vatCountry: str("vatCountry"), vatNumber: str("vatNumber"), name: str("name"), domain: str("domain"), marketplace: str("marketplace"), handle: str("handle") },
    {
      businesses: () => BusinessLog.fromEnv().all(),
      badges: () => VerifiedSellerLog.fromEnv().all(),
      upheld: () => DecisionLog.fromEnv().upheldCounts(),
    },
  );
  return result.ok ? NextResponse.json(result.report) : NextResponse.json({ error: result.error }, { status: 400 });
}
