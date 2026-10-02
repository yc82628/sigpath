import { NextRequest, NextResponse } from "next/server";
import { listWatches } from "@/lib/alerts/api";
import { WatchStore } from "@/lib/alerts/watches";

// POST /api/alerts/list  { endpoint } -> { watches }
// POST, not GET: the endpoint is a credential and must not sit in a URL or a log.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const r = await listWatches(body, WatchStore.fromEnv());
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ watches: r.watches });
}
