/**
 * lib/marketplace/label.ts — the SigPath-checked label: every check, one verdict.
 *
 * The checks already exist — the price comparison, the duplicate-photo and
 * new-account flags, upheld reports, the verified-seller badge — but a buyer
 * scanning twenty listings won't read five separate notes on each. So each
 * listing gets ONE of three verdicts, with the reasons underneath:
 *
 *   checked    — its price was compared with enough same-condition listings
 *                and nothing raised a flag
 *   caution    — something did ("Look closer", with what and why)
 *   unchecked  — nothing raised a flag, but its price couldn't be compared
 *
 * THE WORDING IS THE PRODUCT
 * "Checked" means checked, not guaranteed: SigPath compared the price and the
 * seller signals, it did not hold the item. Every surface that shows the label
 * says so, and points to what happens if a fake gets through anyway (report it;
 * the escrow and the penalty are the backstop). "Unchecked" is grey and
 * neutral — a handmade mug on Etsy isn't suspicious for having no retail
 * median, and colouring it like a warning would defame honest sellers.
 *
 * A verified-seller badge never upgrades a verdict. It vouches for the
 * account, not the price, so it is listed as a point and nothing more.
 */

import type { Analysis, Flag } from "./anomaly";
import { formatMoney, listingKey, totalPrice, type Listing, type Money } from "./types";
import { priceCheckFor, type PriceCheck } from "../checkout/eligibility";

export type Verdict = "checked" | "caution" | "unchecked";

export interface LabelPoint {
  tone: "good" | "warn" | "info";
  text: string;
}

export interface CheckLabel {
  verdict: Verdict;
  headline: string;
  points: LabelPoint[];
}

const HEADLINE: Record<Verdict, string> = {
  checked: "SigPath-checked",
  caution: "Look closer",
  unchecked: "Not price-checked",
};

/** One line, shown once on the results page, saying exactly what "checked" covers. */
export const CHECKED_MEANS =
  "SigPath-checked means its price is in line with the market for its condition, and nothing about the seller or photos raised a flag. It isn't a guarantee the item is genuine — if it isn't, report it.";

function conditionGroup(l: Listing): "new" | "used" {
  return l.condition === "used" ? "used" : "new";
}

/** How many same-condition listings this one's price was compared with. */
function comparedWith(l: Listing, a: Analysis): number | undefined {
  return conditionGroup(l) === "used" ? a.used?.sampleSize : a.sampleSize;
}

function marketplaces(a: Analysis): string {
  const names = a.coverage.map((m) => (m === "ebay" ? "eBay" : m === "stub" ? "the demo feed" : m[0].toUpperCase() + m.slice(1)));
  return names.length <= 1 ? (names[0] ?? "one marketplace") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function checkLabel(
  listing: Listing,
  flags: Flag[],
  priceCheck: PriceCheck,
  analysis: Analysis,
  verifiedSeller: boolean,
): CheckLabel {
  const points: LabelPoint[] = [];
  const badgePoint: LabelPoint = {
    tone: "info",
    text: "Verified seller: proved control of this account and passed a live check. That vouches for the account, not this price.",
  };

  if (flags.length > 0) {
    for (const f of flags) points.push({ tone: "warn", text: f.message });
    if (verifiedSeller) points.push(badgePoint);
    return { verdict: "caution", headline: HEADLINE.caution, points };
  }

  if (priceCheck.checked) {
    const n = comparedWith(listing, analysis);
    const group = conditionGroup(listing) === "used" ? "used" : "new or refurbished";
    points.push({
      tone: "good",
      text: n ? `Price in line with the market: compared across ${n} ${group} listings on ${marketplaces(analysis)}.` : `Price in line with other ${group} listings.`,
    });
  } else {
    points.push({ tone: "info", text: priceCheck.reason });
  }
  // True in both cases: the seller and photo checks ran whether or not the price could be compared.
  points.push({ tone: priceCheck.checked ? "good" : "info", text: "No warnings about this seller or its photos." });
  if (verifiedSeller) points.push({ ...badgePoint, tone: "good" });

  const verdict: Verdict = priceCheck.checked ? "checked" : "unchecked";
  return { verdict, headline: HEADLINE[verdict], points };
}

export interface BestDeal {
  listing: Listing;
  group: "new" | "used";
  total: Money;
  /** How far below the same-condition median, when that's positive. */
  belowMedian?: Money;
}

/**
 * The cheapest CHECKED listing in each condition group — the deal a shopper
 * came for, restricted to the ones that passed. New and used are kept apart:
 * a used item "beating" every new one is not the same deal.
 */
export function bestCheckedDeals(
  listings: Listing[],
  labelOf: (l: Listing) => CheckLabel,
  analysis: Analysis,
): BestDeal[] {
  const best = new Map<"new" | "used", BestDeal>();
  for (const l of listings) {
    if (labelOf(l).verdict !== "checked") continue;
    const total = totalPrice(l);
    if (total.currency !== analysis.currency) continue;
    const group = conditionGroup(l);
    const cur = best.get(group);
    if (!cur || total.amount < cur.total.amount) {
      const median = group === "used" ? analysis.used?.median : analysis.median;
      const gap = median !== undefined ? median - total.amount : 0;
      best.set(group, { listing: l, group, total, belowMedian: gap > 0 ? { amount: gap, currency: total.currency } : undefined });
    }
  }
  return (["new", "used"] as const).flatMap((g) => (best.has(g) ? [best.get(g)!] : []));
}

export function describeSaving(d: BestDeal): string | null {
  return d.belowMedian ? `${formatMoney(d.belowMedian)} below the typical ${d.group} price` : null;
}

/**
 * Label a whole search result: flags grouped by listing (marketplace AND id),
 * a verdict per listing, and the best checked deals. The search page and the
 * price-drop checker both use this, so an alert can only ever fire for a deal
 * the page would show as SigPath-checked.
 */
export function labelSearch(
  result: { listings: Listing[]; analysis: Analysis },
  isVerified: (l: Listing) => boolean = () => false,
) {
  const a = result.analysis;
  const byKey = new Map<string, Flag[]>();
  for (const f of a.flags) {
    const k = listingKey({ source: f.source, id: f.listingId });
    byKey.set(k, [...(byKey.get(k) ?? []), f]);
  }
  const flagsOf = (l: Listing) => byKey.get(listingKey(l)) ?? [];
  const labels = new Map<string, CheckLabel>();
  for (const l of result.listings) labels.set(listingKey(l), checkLabel(l, flagsOf(l), priceCheckFor(l, a), a, isVerified(l)));
  const labelOf = (l: Listing) => labels.get(listingKey(l))!;
  return { flagsOf, labelOf, deals: bestCheckedDeals(result.listings, labelOf, a) };
}

/**
 * A search result with its labels attached, for the JSON API. Purely additive:
 * every existing field is unchanged, so older clients keep working. Built on
 * labelSearch, so the API and the search page can never disagree about a
 * verdict.
 */
export type LabelledListing = Listing & { check: CheckLabel; verifiedSeller: boolean };

export function withLabels<R extends { listings: Listing[]; analysis: Analysis }>(
  result: R,
  isVerified: (l: Listing) => boolean = () => false,
): Omit<R, "listings"> & {
  listings: LabelledListing[];
  bestCheckedDeals: { listing: string; group: "new" | "used"; total: Money; belowMedian: Money | null }[];
  checkedMeans: string;
} {
  const { labelOf, deals } = labelSearch(result, isVerified);
  return {
    ...result,
    listings: result.listings.map((l) => ({ ...l, check: labelOf(l), verifiedSeller: isVerified(l) })),
    /** Cheapest SigPath-checked listing per condition, referenced by listingKey. */
    bestCheckedDeals: deals.map((d) => ({ listing: listingKey(d.listing), group: d.group, total: d.total, belowMedian: d.belowMedian ?? null })),
    /** What "checked" means — shown wherever the label is, including in other apps. */
    checkedMeans: CHECKED_MEANS,
  };
}
