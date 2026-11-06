import { NextRequest, NextResponse } from "next/server";
import { confirmPlan } from "@/lib/sellers/business-api";
import { businessDepsFromEnv } from "@/lib/sellers/business-deps";
import { limited, RULES } from "@/lib/guard/limit";

// POST /api/business/plan/confirm  { token }
// Finds the plan payment on chain by its reference key and extends the plan,
// once per payment. 202 while it hasn't landed yet: ask again.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.plan);
  if (tooMany) return tooMany;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await confirmPlan({ token: typeof body?.token === "string" ? body.token : "" }, businessDepsFromEnv());
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
