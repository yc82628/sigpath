import { NextRequest, NextResponse } from "next/server";
import { limited, hit, clientId, clientIp, RULES } from "@/lib/guard/limit";
import { UpstashKv } from "@/lib/kv/upstash";
import { EbaySource } from "@/lib/marketplace/sources/ebay";
import { refreshPrices, type RefreshRequest } from "@/lib/cart/refresh";
import { CART_MAX_ITEMS } from "@/lib/cart/cart";

// POST /api/cart/prices  { items: [{ source, id }] }
//
// The cart (kept in the shopper's browser, lib/cart/cart.ts) asking what its
// items cost now. Only the listings' ids arrive here; nothing is stored or
// logged, and the answer is never cached.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.cart);
  if (tooMany) return tooMany;

  const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
  const raw = Array.isArray(body?.items) ? body!.items : null;
  if (!raw) return NextResponse.json({ error: "Send { items: [{ source, id }] }." }, { status: 400 });
  const items: RefreshRequest[] = [];
  for (const it of raw.slice(0, CART_MAX_ITEMS)) {
    const { source, id } = (it ?? {}) as { source?: unknown; id?: unknown };
    if (typeof source === "string" && /^[a-z]{2,20}$/.test(source) && typeof id === "string" && id.length <= 64) items.push({ source, id });
  }

  // Each eBay item is a call against the site's daily quota: counted one by one.
  const kv = UpstashKv.fromEnv();
  const client = clientId(clientIp(req.headers));
  const prices = await refreshPrices(items, new EbaySource(), async () => (await hit(RULES.cartItem, client, kv)).ok);
  return NextResponse.json({ prices, checkedAt: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
