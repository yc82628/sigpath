import { NextRequest, NextResponse } from "next/server";
import { labelledSearch } from "@/lib/marketplace/labelled-search";

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
//
// THE SIGPATH-CHECKED LABEL
// Each listing carries `check` — one verdict ("checked" | "caution" |
// "unchecked"), a headline and the reasons — plus `verifiedSeller`. The
// response adds `bestCheckedDeals` (by listingKey "source:id") and
// `checkedMeans`, the one-line statement that checked is not a guarantee. An
// app showing the label should show that line too.

export const runtime = "nodejs";

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

  // Same verdicts, same badge rule as the search page.
  const result = await labelledSearch(q, { limit, currency: req.nextUrl.searchParams.get("currency")?.toUpperCase() || undefined });

  // A search where every source failed is a 503: the caller asked a reasonable
  // question and we could not answer it. Returning 200 with an empty list would
  // read as "nothing matches", which is a different and misleading claim.
  const anyOk = result.sources.some((s) => s.status === "ok");
  return NextResponse.json(result, { status: anyOk ? 200 : 503 });
}
