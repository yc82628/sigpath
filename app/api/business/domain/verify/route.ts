import { NextRequest, NextResponse } from "next/server";
import { verifyDomain } from "@/lib/sellers/business-api";
import { businessDepsFromEnv } from "@/lib/sellers/business-deps";
import { RateLimiter } from "@/lib/assistant/rate-limit";

// POST /api/business/domain/verify  { wallet, time, signature, domain }
// Looks up the TXT record and, if it is there, adds the website to the business.

export const runtime = "nodejs";

const limiter = new RateLimiter(20, 10 * 60 * 1000);

export async function POST(req: NextRequest) {
  const client = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  if (!limiter.allow(client)) return NextResponse.json({ error: "Too many checks. Try again in a few minutes." }, { status: 429 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  const r = await verifyDomain(
    { wallet: str("wallet"), time: str("time"), signature: str("signature"), domain: str("domain") },
    businessDepsFromEnv(),
  );
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
