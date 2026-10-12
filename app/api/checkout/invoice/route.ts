import { NextRequest, NextResponse } from "next/server";
import { limited, RULES } from "@/lib/guard/limit";
import { invoiceFor } from "@/lib/checkout/checkout";
import { DecisionLog } from "@/lib/reports/reports";

// POST /api/checkout/invoice  { quotes: string[] }
//   -> { lines: [{ title, amount, currency, itemUsdc, feeUsdc, totalUsdc }], totalUsdc, rate }
//
// The invoice the checkout shows before the shopper pays: each item, its
// price, and every conversion to USDC, computed by the same code as the
// payment itself (lib/checkout/checkout.ts). It charges nothing and stores nothing.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.cart);
  if (tooMany) return tooMany;
  const body = (await req.json().catch(() => null)) as { quotes?: unknown } | null;
  const r = await invoiceFor(body?.quotes, { upheldReports: await DecisionLog.fromEnv().upheldCounts() });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
