import { NextRequest, NextResponse } from "next/server";
import { collectInbox } from "@/lib/alerts/api";
import { WatchStore } from "@/lib/alerts/watches";

// POST /api/alerts/inbox  { endpoint } -> { alerts }
//
// Called by the service worker when an (empty) push arrives: the push carries
// nothing, so this is where the notification text comes from. Collected
// alerts are cleared.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const r = await collectInbox(body, WatchStore.fromEnv());
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ alerts: r.alerts });
}
