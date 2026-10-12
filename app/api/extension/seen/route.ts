import { NextRequest, NextResponse } from "next/server";
import { limited, RULES } from "@/lib/guard/limit";
import { SeenStore, SEEN_MAX_ITEMS } from "@/lib/extension/seen";

// POST /api/extension/seen  { items: [{ asin, title, price: { amount, currency }, imageUrl? }] }
//
// The SigPath extension, with its "share prices" switch on, reporting the
// products and prices on an Amazon.de page the shopper opened (lib/extension/
// seen.ts). Products and prices only: nothing about the shopper is sent, kept
// or logged. Anything malformed is dropped.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.extensionSeen);
  if (tooMany) return tooMany;
  const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
  if (!Array.isArray(body?.items)) return NextResponse.json({ error: "Send { items: [...] }." }, { status: 400 });
  const kept = await SeenStore.fromEnv().record(body!.items.slice(0, SEEN_MAX_ITEMS));
  return NextResponse.json({ kept }, { headers: { "Cache-Control": "no-store" } });
}
