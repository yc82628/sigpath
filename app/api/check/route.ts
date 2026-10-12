import { NextRequest, NextResponse } from "next/server";
import { labelledSearch } from "@/lib/marketplace/labelled-search";
import { agentCheck, gatewayAuthorised, GATEWAY_HEADER } from "@/lib/agents/check";
import { withoutSiteOnly } from "@/lib/marketplace/site-only";
import { limited, RULES } from "@/lib/guard/limit";

// GET /api/check?q=thinkpad+x1
//
// The deal check for AI shopping agents, paid per request in USDC through the
// pay.sh gateway (paysh/sigpath.yaml). Agents call the gateway, not this
// route: the gateway answers 402 with the price, settles the agent's signed
// USDC transfer on Solana, then forwards here with the gateway key.
//
// Like /api/search it reads nothing about the caller and logs no query.
// Etsy and AliExpress listings are left out: they stay on SigPath's own pages
// (lib/marketplace/site-only.ts).

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!gatewayAuthorised(req.headers.get(GATEWAY_HEADER), process.env.SIGPATH_GATEWAY_KEY)) {
    return NextResponse.json(
      { error: "Call this through SigPath's pay.sh gateway, which handles the USDC payment. See /agents." },
      { status: 401 },
    );
  }

  // Paid traffic isn't limited; the open origin (no gateway key) is, like a search.
  if (!process.env.SIGPATH_GATEWAY_KEY?.trim()) {
    const tooMany = await limited(req.headers, RULES.search);
    if (tooMany) return tooMany;
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ error: "Pass ?q=<search terms>." }, { status: 400 });
  if (q.length > 120) return NextResponse.json({ error: "Query is too long." }, { status: 400 });

  const result = withoutSiteOnly(await labelledSearch(q, { limit: 20, currency: req.nextUrl.searchParams.get("currency")?.toUpperCase() || undefined }));
  const anyOk = result.sources.some((s) => s.status === "ok");
  return NextResponse.json(agentCheck(q, result), { status: anyOk ? 200 : 503 });
}
