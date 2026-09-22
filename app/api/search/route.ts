import { NextRequest, NextResponse } from "next/server";
import { searchAll } from "@/lib/marketplace/search";
import { StubSource } from "@/lib/marketplace/sources/stub";
import { EbaySource } from "@/lib/marketplace/sources/ebay";
import { AmazonSource } from "@/lib/marketplace/sources/amazon";
import type { MarketplaceSource } from "@/lib/marketplace/sources/types";

// GET /api/search?q=thinkpad+x1
//
// NO ACCOUNTS, BY DESIGN
// This route reads nothing about who is calling: no session, no cookie, no
// user id, and it writes no log tying a query to a person. A search is a pure
// function of its query string. That is the product decision ("no login") and
// it is also why there is no personal data here to lose.
//
// WHAT MAKES THIS MORE THAN A METASEARCH
// The response carries an `analysis` block computed ACROSS marketplaces: a
// listing far below the cross-platform median, or the same photograph under
// two different seller names. Neither is visible from inside a single
// marketplace, which is the whole argument for aggregating in the first place.
//
// It also carries `sources` — every marketplace asked, including the ones that
// failed. That is not diagnostics padding. When a source is missing, the price
// comparison is withheld rather than computed over a biased sample, and the
// buyer is told why.

export const runtime = "nodejs";

/**
 * Sources are chosen per request rather than cached in a module, so that
 * setting credentials takes effect on the next request instead of the next
 * deploy. EbaySource reports `not_configured` when its keys are absent, which
 * is exactly what should happen before the developer account exists — the
 * search still works, and the analysis knows to hold back.
 */
function sources(): MarketplaceSource[] {
  // The fixed set of API-reachable marketplaces. idealo and Kleinanzeigen are
  // covered too, but as link-outs rather than sources — see registry.ts for why
  // there is no API we are permitted to query.
  const list: MarketplaceSource[] = [new EbaySource(), new AmazonSource()];
  // The offline feed stays on until a real source is configured, so the route
  // is demonstrable with no credentials at all. Set STUB_FEED=false to drop it.
  if (process.env.STUB_FEED !== "false") list.push(new StubSource());
  return list;
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ error: "Pass ?q=<search terms>." }, { status: 400 });
  }
  if (q.length > 120) {
    return NextResponse.json({ error: "Query is too long." }, { status: 400 });
  }

  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 20;

  const result = await searchAll(q, sources(), {
    limit,
    currency: req.nextUrl.searchParams.get("currency")?.toUpperCase() || undefined,
  });

  // A search where every source failed is a 503: the caller asked a reasonable
  // question and we could not answer it. Returning 200 with an empty list would
  // read as "nothing matches", which is a different and misleading claim.
  const anyOk = result.sources.some((s) => s.status === "ok");
  return NextResponse.json(result, { status: anyOk ? 200 : 503 });
}
