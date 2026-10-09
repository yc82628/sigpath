import { NextRequest, NextResponse } from "next/server";
import { moonPayBuyUrl, moonPayConfig } from "@/lib/onramp/moonpay";

// GET /api/onramp/moonpay?wallet=<address>&usdc=<amount>&back=<checkout url>
//   -> { url, test }
//
// A signed MoonPay buy link for the shopper's own wallet. The secret key stays
// here; the browser only ever sees the finished link. Nothing is stored or
// logged: the wallet is public, and the amount is all MoonPay needs.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = moonPayConfig();
  if (!cfg) return NextResponse.json({ error: "Buying USDC through MoonPay isn't set up on this site." }, { status: 503 });

  const p = req.nextUrl.searchParams;
  const usdc = Number(p.get("usdc"));
  if (p.has("usdc") && (!Number.isFinite(usdc) || usdc <= 0 || usdc > 10_000)) {
    return NextResponse.json({ error: "Invalid amount." }, { status: 400 });
  }

  // Back to the page the shopper came from, and only to this site.
  let back: string | undefined;
  const raw = p.get("back");
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.origin === req.nextUrl.origin && u.protocol === "https:") back = u.toString();
    } catch {
      /* ignored: MoonPay then just ends on its own page */
    }
  }

  try {
    const url = moonPayBuyUrl(cfg, { wallet: String(p.get("wallet") ?? ""), usdc: p.has("usdc") ? usdc : undefined, redirectUrl: back });
    return NextResponse.json({ url, test: cfg.test }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Invalid wallet address." }, { status: 400 });
  }
}
