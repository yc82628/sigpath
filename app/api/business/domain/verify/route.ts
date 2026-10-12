import { NextRequest, NextResponse } from "next/server";
import { verifyDomain } from "@/lib/sellers/business-api";
import { businessDepsFromEnv } from "@/lib/sellers/business-deps";
import { limited, RULES } from "@/lib/guard/limit";

// POST /api/business/domain/verify  { wallet, time, signature, domain }
// Looks up the TXT record and, if it is there, adds the website to the business.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.domain);
  if (tooMany) return tooMany;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  const r = await verifyDomain(
    { wallet: str("wallet"), time: str("time"), signature: str("signature"), domain: str("domain") },
    businessDepsFromEnv(),
  );
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
