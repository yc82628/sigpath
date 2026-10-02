import { NextRequest, NextResponse } from "next/server";
import { deleteWatch } from "@/lib/alerts/api";
import { WatchStore } from "@/lib/alerts/watches";

// POST /api/alerts/delete  { endpoint, id } | { endpoint, all: true } -> { deleted }

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) ?? {};
  const r = await deleteWatch(body, WatchStore.fromEnv());
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ deleted: r.deleted });
}
