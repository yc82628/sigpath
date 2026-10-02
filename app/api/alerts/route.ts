import { NextRequest, NextResponse } from "next/server";
import { createWatch } from "@/lib/alerts/api";
import { WatchStore } from "@/lib/alerts/watches";

// POST /api/alerts  { subscription, query, group, target: { amount, currency } }
//   -> { watch }
//
// Create a price-drop alert. The browser's push subscription is the only
// "account". NOTHING FROM THE BODY IS LOGGED: the endpoint is a credential and
// the query is the shopper's.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const r = await createWatch(body, { store: WatchStore.fromEnv() });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ watch: r.watch });
}
