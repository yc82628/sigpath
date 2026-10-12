import { NextRequest, NextResponse } from "next/server";
import { clientId, clientIp, hit, limited, RULES } from "@/lib/guard/limit";
import { UpstashKv } from "@/lib/kv/upstash";
import { defaultRequoteDeps, requoteItem, type RequoteItem } from "@/lib/cart/requote";
import { MAX_CART_ORDERS } from "@/lib/checkout/checkout";

// POST /api/cart/requote  { items: [{ source, id, title }] }
//
// Fresh signed quotes for cart items whose thirty-minute quote has run out:
// each item is searched and checked again exactly as the search page does it
// (lib/cart/requote.ts). Nothing is stored; each item counts as one search.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.cart);
  if (tooMany) return tooMany;
  const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
  if (!Array.isArray(body?.items)) return NextResponse.json({ error: "Send { items: [{ source, id, title }] }." }, { status: 400 });
  const items: RequoteItem[] = [];
  for (const it of body!.items.slice(0, MAX_CART_ORDERS)) {
    const { source, id, title } = (it ?? {}) as Record<string, unknown>;
    if (typeof source === "string" && /^[a-z]{2,20}$/.test(source) && typeof id === "string" && id.length <= 64 && typeof title === "string" && title.length <= 300) {
      items.push({ source, id, title });
    }
  }
  const kv = UpstashKv.fromEnv();
  const client = clientId(clientIp(req.headers));
  const deps = defaultRequoteDeps();
  const quotes = await Promise.all(
    items.map(async (it) =>
      (await hit(RULES.search, client, kv)).ok
        ? requoteItem(it, deps)
        : { ok: false as const, key: `${it.source}:${it.id}`, reason: RULES.search.message },
    ),
  );
  return NextResponse.json({ quotes }, { headers: { "Cache-Control": "no-store" } });
}
