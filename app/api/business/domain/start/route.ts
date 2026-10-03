import { NextRequest, NextResponse } from "next/server";
import { startDomain } from "@/lib/sellers/business-api";
import { businessDepsFromEnv } from "@/lib/sellers/business-deps";

// POST /api/business/domain/start  { wallet, domain }
// The DNS record that proves the website. The value is bound to this wallet and
// domain, so asking for it proves nothing: only adding it to the domain does.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  const r = await startDomain({ wallet: str("wallet"), domain: str("domain") }, businessDepsFromEnv());
  return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status });
}
