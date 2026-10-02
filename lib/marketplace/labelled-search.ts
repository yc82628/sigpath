/**
 * lib/marketplace/labelled-search.ts — one search, with the SigPath verdicts.
 *
 * The pipeline /api/search and /api/check share: search every source, flag
 * sellers with upheld reports, then label each listing with the same verdict
 * and badge rule as the search page. One place, so the paid agent endpoint can
 * never drift from what a shopper sees.
 */

import { searchAll } from "./search";
import { defaultSources } from "./sources";
import { withLabels } from "./label";
import { sellerKey } from "./types";
import { DecisionLog } from "../reports/reports";
import { VerifiedSellerLog, badgeFor } from "../sellers/verified-log";

export async function labelledSearch(q: string, opts: { limit: number; currency?: string }) {
  const upheldReports = await DecisionLog.fromEnv().upheldCounts();
  const raw = await searchAll(q, defaultSources(), opts, { upheldReports });
  const badges = await VerifiedSellerLog.fromEnv().all();
  return withLabels(raw, (l) => badgeFor(sellerKey(l.source, l.seller.handle), badges, upheldReports) !== null);
}

export type LabelledSearch = Awaited<ReturnType<typeof labelledSearch>>;
