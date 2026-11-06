import { NextRequest, NextResponse } from "next/server";
import { startPlan } from "@/lib/sellers/business-api";
import { businessDepsFromEnv } from "@/lib/sellers/business-deps";
import { limited, RULES } from "@/lib/guard/limit";

// POST /api/business/plan/start  { wallet, period: "month" | "year" }
// Builds the Verified business plan payment (lib/sellers/plan.ts) for the
// wallet to sign and send, and a signed token to confirm it with.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.plan);
  if (tooMany) return tooMany;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  const r = await startPlan({ wallet: str("wallet"), period: str("period") }, businessDepsFromEnv());
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
