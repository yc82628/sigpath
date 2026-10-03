/**
 * lib/marketplace/labelled-search.ts — one search, with the SigPath verdicts.
 *
 * The pipeline /api/search and /api/check share: search every source, flag
 * sellers with upheld reports, then label each listing with the same verdict
 * and badge rule as the search page, plus the verified-business tier. One
 * place, so the paid agent endpoint can never drift from what a shopper sees.
 */

import { searchAll } from "./search";
import { defaultSources } from "./sources";
import { withLabels } from "./label";
import { sellerKey } from "./types";
import { DecisionLog } from "../reports/reports";
import { VerifiedSellerLog, badgeFor } from "../sellers/verified-log";
import { BusinessLog, businessIndex, verifiedPhotoFlags } from "../sellers/business";

export async function labelledSearch(q: string, opts: { limit: number; currency?: string }) {
  const upheldReports = await DecisionLog.fromEnv().upheldCounts();
  const raw = await searchAll(q, defaultSources(), opts, { upheldReports });
  const badges = await VerifiedSellerLog.fromEnv().all();
  const businesses = businessIndex(await BusinessLog.fromEnv().all(), badges, upheldReports);
  // A verified business's photo under an account it hasn't linked, on another marketplace.
  raw.analysis = { ...raw.analysis, flags: [...raw.analysis.flags, ...verifiedPhotoFlags(raw.listings, businesses)] };
  const key = (l: { source: string; seller: { handle: string } }) => sellerKey(l.source, l.seller.handle);
  return withLabels(
    raw,
    (l) => badgeFor(key(l), badges, upheldReports) !== null,
    (l) => businesses.get(key(l)) ?? null,
  );
}

export type LabelledSearch = Awaited<ReturnType<typeof labelledSearch>>;
