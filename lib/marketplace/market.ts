/**
 * lib/marketplace/market.ts — what a product costs right now, at a glance.
 *
 * The search already works out a typical price for new and for used listings
 * of the same product (anomaly.ts). This turns that into what a shopper reads
 * before looking at a single offer: the typical price, the range most offers
 * fall in, how many there are, and where the prices sit (a small histogram).
 * And, per listing, how far it is from the typical price of the listings it
 * was compared with: its deal score.
 *
 * Only listings whose price was actually compared count, so a charging case
 * never drags the "used AirPods" range down, and the demo feed is never mixed
 * with real marketplaces.
 */

import type { Analysis } from "./anomaly";
import { listingKey, totalPrice, type Listing } from "./types";

export const BINS = 8;

export interface MarketGroup {
  group: "new" | "used";
  /** The typical (median) price the search compared against, in minor units. */
  typical: number;
  /** How many listings the price picture is drawn from. */
  count: number;
  /** The range the middle 80% of those listings fall in. */
  low: number;
  high: number;
  /** Cheapest and dearest compared listing. */
  min: number;
  max: number;
  /** How many listings fall in each of BINS equal price bands from min to max. */
  bins: number[];
  /** Which band the typical price falls in. */
  typicalBin: number;
}

/** The value at fraction p (0..1) of sorted values, by nearest rank. */
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) throw new Error("quantile of nothing");
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

const groupOf = (l: Listing): "new" | "used" => (l.condition === "used" ? "used" : "new");

export function marketSnapshot(listings: Listing[], analysis: Analysis): MarketGroup[] {
  if (analysis.status !== "ok") return [];
  const hasReal = listings.some((l) => l.source !== "stub" && analysis.comparisons[listingKey(l)]);
  const compared = listings.filter((l) => analysis.comparisons[listingKey(l)] && (!hasReal || l.source !== "stub"));
  const typicalOf = { new: analysis.median, used: analysis.used?.median };

  return (["new", "used"] as const).flatMap((group): MarketGroup[] => {
    const typical = typicalOf[group];
    const totals = compared
      .filter((l) => groupOf(l) === group && totalPrice(l).currency === analysis.currency)
      .map((l) => totalPrice(l).amount)
      .sort((a, b) => a - b);
    if (typical === undefined || totals.length < 2) return [];
    const min = totals[0];
    const max = totals[totals.length - 1];
    const width = Math.max(1, (max - min) / BINS);
    const binOf = (v: number) => Math.min(BINS - 1, Math.floor((v - min) / width));
    const bins = Array.from({ length: BINS }, () => 0);
    for (const t of totals) bins[binOf(t)]++;
    return [
      {
        group,
        typical,
        count: totals.length,
        low: quantile(totals, 0.1),
        high: quantile(totals, 0.9),
        min,
        max,
        bins,
        typicalBin: binOf(Math.min(max, Math.max(min, typical))),
      },
    ];
  });
}

/**
 * How far a listing's price is from the typical price of the listings it was
 * compared with, in whole percent: -22 is 22% below. Null when it wasn't
 * compared, so no listing gets a score it didn't earn.
 */
export function dealScore(l: Listing, analysis: Analysis): number | null {
  const c = analysis.comparisons[listingKey(l)];
  if (!c || c.median <= 0) return null;
  return Math.round(((totalPrice(l).amount - c.median) / c.median) * 100);
}

/**
 * Whether a group's prices spread so widely that the search likely covers
 * several models: the top of the usual range more than twice its bottom
 * ("AirPods Pro" holds Pro 1, 2 and 3, from 55 € to 195 € used).
 */
export function isWide(g: MarketGroup): boolean {
  return g.low > 0 && g.high > g.low * 2;
}

/**
 * Whether to suggest a more specific search: the prices spread widely AND the
 * search names no generation or size yet. "AirPods Pro" gets the hint;
 * "AirPods Pro 2" doesn't, since adding the number is what it would suggest
 * and its spread comes from somewhere else (cheap "new" listings).
 */
export function suggestNarrower(groups: MarketGroup[], query: string): boolean {
  return groups.some(isWide) && !/\d/.test(query);
}

/** How a score reads: a real saving, about the usual price, or above it. */
export function dealTone(pct: number): "good" | "fair" | "high" {
  return pct <= -10 ? "good" : pct >= 10 ? "high" : "fair";
}
