import { NextRequest, NextResponse } from "next/server";
import { submitVat } from "@/lib/sellers/business-api";
import { businessDepsFromEnv } from "@/lib/sellers/business-deps";
import { limited, RULES } from "@/lib/guard/limit";

// POST /api/business/vat  { wallet, time, signature, country, vatNumber }
// Checks the VAT number against the EU's VIES register and attaches the
// business to the wallet's verified accounts. Signed by that wallet.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.vat);
  if (tooMany) return tooMany;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  const r = await submitVat(
    { wallet: str("wallet"), time: str("time"), signature: str("signature"), country: str("country"), vatNumber: str("vatNumber") },
    businessDepsFromEnv(),
  );
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
