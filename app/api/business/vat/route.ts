import { NextRequest, NextResponse } from "next/server";
import { submitVat } from "@/lib/sellers/business-api";
import { businessDepsFromEnv } from "@/lib/sellers/business-deps";
import { RateLimiter } from "@/lib/assistant/rate-limit";

// POST /api/business/vat  { wallet, time, signature, country, vatNumber }
// Checks the VAT number against the EU's VIES register and attaches the
// business to the wallet's verified accounts. Signed by that wallet.

export const runtime = "nodejs";

// The register is a shared public service: 10 checks per 10 minutes per client.
const limiter = new RateLimiter(10, 10 * 60 * 1000);

export async function POST(req: NextRequest) {
  const client = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  if (!limiter.allow(client)) return NextResponse.json({ error: "Too many checks. Try again in a few minutes." }, { status: 429 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  const r = await submitVat(
    { wallet: str("wallet"), time: str("time"), signature: str("signature"), country: str("country"), vatNumber: str("vatNumber") },
    businessDepsFromEnv(),
  );
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
