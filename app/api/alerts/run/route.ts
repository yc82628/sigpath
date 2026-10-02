import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runAlertCheck } from "@/lib/alerts/api";

// POST /api/alerts/run   Authorization: Bearer <ALERTS_CRON_SECRET>
//
// One pass of the price-drop checker, for a hosted scheduler. Locally, run
// `npx tsx scripts/alerts-check.ts` instead. Without the secret configured
// this route does nothing: an open trigger would let anyone burn the
// marketplace API quotas.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = process.env.ALERTS_CRON_SECRET?.trim();
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const r = await runAlertCheck();
  if ("ok" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
