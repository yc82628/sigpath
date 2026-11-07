import { NextRequest, NextResponse } from "next/server";
import { limited, RULES } from "@/lib/guard/limit";
import { count } from "@/lib/stats/counter";

// POST /api/stats/click   (no body)
//
// A shopper opened a listing from the search results (app/components/ClickCounter.tsx).
// Adds one to today's click total (lib/stats/counter.ts) and nothing else: which
// listing, which search and who clicked are never sent.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // A script can't pad the totals past what one person could click.
  const tooMany = await limited(req.headers, RULES.click);
  if (tooMany) return new NextResponse(null, { status: 204 });
  await count(["click"], { userAgent: req.headers.get("user-agent") });
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
