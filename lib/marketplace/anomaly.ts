/**
 * lib/marketplace/anomaly.ts — the cross-marketplace security signal.
 *
 * WHAT THIS SEES THAT A SINGLE MARKETPLACE CANNOT
 * Inside one marketplace, a listing at 40% of the going rate looks like a
 * bargain. Across four marketplaces it looks like what it usually is. The
 * aggregator has the one vantage point from which the comparison is possible,
 * so this is the part of the product that is a security feature rather than a
 * convenience.
 *
 * THE FAILURE MODE THAT MATTERS
 * A false scam flag on an honest seller is worse than a missed scam. A missed
 * scam leaves the buyer where they already were; a false flag actively
 * misinforms them and defames a seller. So every rule here fails toward
 * SILENCE, and the module refuses to answer more readily than it answers
 * wrongly.
 *
 * It refuses when:
 *   - any source is degraded, so the sample is biased (see below)
 *   - the sample is too small for a median to mean anything
 *   - the comparison would mix currencies or conditions (new and used are
 *     compared separately, each against its own median)
 *   - the listings are not the same product: each listing is compared only
 *     with listings whose model, generation, storage and RAM do not conflict
 *     with its own (see identity.ts), and accessories and for-parts items are
 *     never compared at all
 *   - the listing sits in a different marketplace category from most results
 *     (a game in a console search), or its title doesn't name the product
 *
 * WHY DEGRADED COVERAGE MUST BLOCK THE WHOLE CHECK
 * This is the same bug that produced three confidently wrong runs in the
 * footprint benchmark: a rate-limited collector was skipped, the score was
 * computed from the signals that remained, and the number looked entirely
 * plausible. Here the consequence is worse than a wrong number. Suppose the
 * expensive marketplace times out and only the cheap one answers: the median
 * drops, and ordinary listings on the cheap platform start reading as
 * underpriced. The check would be most confident exactly when it is least
 * entitled to be.
 */

import type { Listing, MarketplaceId, SourceResult } from "./types";
import { listingKey, totalPrice } from "./types";
import { identify, sameProduct, type Identity } from "./identity";

/** The offline demo feed (sources/stub.ts): invented prices, compared only with each other. */
const DEMO_SOURCE = "stub";

/**
 * Below this fraction of the comparable median, a listing is flagged.
 *
 * 0.5 is deliberately far out. Legitimate clearance, damaged goods and urgent
 * sales routinely reach 60-70% of median, and flagging those is the false
 * positive this module exists to avoid. Tune with real data before trusting a
 * tighter value.
 */
export const UNDERPRICED_RATIO = 0.5;

/**
 * Fewer comparable listings than this and no median is reported.
 *
 * A "median" of three prices is one price with extra steps: a single outlier
 * moves it far enough to invert the verdict.
 */
export const MIN_SAMPLE = 5;

/** A listing this new from an account this new is worth saying out loud. */
export const NEW_ACCOUNT_DAYS = 30;

export type AnalysisStatus =
  | "ok"
  /** Some source failed, so the sample is biased. No verdict is issued. */
  | "incomplete_coverage"
  /** Not enough comparable listings for a median to mean anything. */
  | "insufficient_sample";

/**
 * `upheld_reports` is added by search, not by analyse(): it comes from reviewed
 * buyer reports about the SELLER, not from anything in this result set. So is
 * `photo_of_verified_business` (lib/sellers/business.ts), which needs to know
 * which accounts a verified business has linked.
 */
export type FlagKind = "underpriced" | "duplicate_image" | "new_account" | "upheld_reports" | "photo_of_verified_business";

export interface Flag {
  /**
   * The listing's marketplace AND id. Ids are only unique within one
   * marketplace — grouping flags by id alone would hang an eBay listing's flag
   * on an Etsy listing that happens to share its number. Group by
   * listingKey({ source, id: listingId }).
   */
  source: MarketplaceId;
  listingId: string;
  kind: FlagKind;
  /** Shown to the buyer. Plain language, no jargon, no accusation. */
  message: string;
}

export interface Analysis {
  status: AnalysisStatus;
  /** Why no verdict, when status is not ok. Shown to the buyer. */
  reason?: string;
  /**
   * Per listing (by listingKey): how many same-product listings its price was
   * compared with, and their median. Only listings that were price-checked.
   */
  comparisons: Record<string, { sampleSize: number; median: number; scope?: string }>;
  /**
   * Per listing: why its price was NOT compared, when that is specific to the
   * listing: an accessory, sold for parts, or too few of the same product.
   */
  notCompared: Record<string, string>;
  /** Per listing: what its title says it is (identity.ts). */
  identities: Record<string, Identity>;
  /**
   * Whether reviewed buyer reports were looked up for these sellers. Set by
   * search, which has the decision log; analyse() alone cannot know.
   */
  reportsChecked: boolean;
  /**
   * Median total price of NEW and refurbished PRODUCT listings (accessories
   * and for-parts items left out), when there were enough. A summary for the
   * page: each listing's own verdict uses `comparisons`, not this.
   */
  median?: number;
  /** Where the summary medians come from, e.g. "on eBay" or "on the demo feed". */
  medianScope?: string;
  currency?: string;
  /** How many new/refurbished listings that median was taken over. */
  sampleSize?: number;
  /**
   * The same comparison for USED listings, run separately. A used unit is only
   * ever compared with other used units: against new ones, every honest used
   * item would look cheap. Absent when there were too few used listings.
   */
  used?: { median: number; sampleSize: number };
  /**
   * listingKey() of every listing whose price was compared against a
   * same-condition median — flagged or not. The checkout gate reads this:
   * SigPath only buys what it could price-check, because a price nobody could
   * check is exactly where a scam hides.
   */
  priceChecked: string[];
  /**
   * Which marketplaces the median actually covers.
   *
   * The buyer needs this to read the verdict correctly: "below the median
   * across four marketplaces" and "below the median on the one marketplace we
   * could search" are different claims, and only naming the sources keeps them
   * apart.
   */
  coverage: MarketplaceId[];
  flags: Flag[];
  /**
   * Price-comparable sources that SHOULD have answered and did not — rate
   * limited, timed out, errored. These bias the sample and block the price
   * comparison. A failed NON-comparable source is not listed here: it was never
   * going to contribute to the median, so its absence biases nothing. (It still
   * shows as failed in the search response's per-source status.)
   */
  degraded: { source: MarketplaceId; status: string; detail?: string }[];
  /**
   * Sources that answered but whose prices were deliberately kept out of the
   * median because they describe different goods (see
   * MarketplaceSource.priceComparable). Named so the buyer can see why a cheap
   * listing from one of them carries no price flag.
   */
  excludedFromComparison: MarketplaceId[];
  /**
   * Sources with no credentials configured.
   *
   * Deliberately NOT treated as degraded. An unconfigured source is not missing
   * data, it is a marketplace this deployment does not search — the operator
   * chose that, and it does not skew a median any more than a marketplace we
   * never integrated does. Treating the two the same meant the price check
   * could never run until every planned source had credentials, which is both
   * useless in development and wrong in principle.
   *
   * Still reported, because the buyer should know what was not searched.
   */
  notConfigured: MarketplaceId[];
}

/** The category most of these listings share; ties go to the first seen. */
export function mainCategory(listings: Listing[]): { id: string; name: string } | undefined {
  const counts = new Map<string, { category: { id: string; name: string }; n: number }>();
  for (const l of listings) {
    if (!l.category) continue;
    const c = counts.get(l.category.id) ?? { category: l.category, n: 0 };
    c.n++;
    counts.set(l.category.id, c);
  }
  let best: { category: { id: string; name: string }; n: number } | undefined;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.category;
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("median of an empty set");
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Flags that do not depend on a price comparison.
 *
 * These are safe to compute even when coverage is incomplete, because they are
 * properties of a single listing rather than of the sample. A duplicated image
 * across two sellers is true whether or not a third marketplace answered.
 */
function coverageIndependentFlags(listings: Listing[], now: number): Flag[] {
  const flags: Flag[] = [];

  // --- the same photograph under different sellers ---------------------------
  //
  // WITHIN ONE MARKETPLACE this is unambiguous: two handles on the same site
  // are two accounts, and two accounts using one photograph is worth saying.
  //
  // ACROSS MARKETPLACES IT IS NOT, and this is the interesting part. One
  // person cross-posting their own item is the entire premise of this site, and
  // that same person may well trade as `bobsdeals` on one platform and
  // `bob_deals` on another. From the outside, "one seller on two sites" and
  // "two sellers sharing a stolen photo" look identical — there is no way to
  // tell them apart without knowing whether the two accounts belong to the same
  // person.
  //
  // Which is exactly what the verification half of this product establishes: a
  // seller proves control of accounts on several platforms and the link becomes
  // checkable (see lib/footprint and the attestation path). Until a listing's
  // seller is verified, the honest answer is silence, because a false accusation
  // against an ordinary cross-poster is the worst thing this module could do.
  //
  // So: flag only same-marketplace collisions. Cross-marketplace ones wait for
  // an identity link rather than being guessed at.
  const byImage = new Map<string, Listing[]>();
  for (const l of listings) {
    if (!l.imageHash) continue;
    const bucket = byImage.get(l.imageHash) ?? [];
    bucket.push(l);
    byImage.set(l.imageHash, bucket);
  }

  for (const bucket of byImage.values()) {
    const bySource = new Map<string, Listing[]>();
    for (const l of bucket) {
      const same = bySource.get(l.source) ?? [];
      same.push(l);
      bySource.set(l.source, same);
    }

    for (const sameSource of bySource.values()) {
      const handles = new Set(sameSource.map((l) => l.seller.handle.toLowerCase()));
      if (handles.size < 2) continue;
      for (const l of sameSource) {
        flags.push({
          source: l.source,
          listingId: l.id,
          kind: "duplicate_image",
          message: `This photo appears on ${handles.size} different seller accounts on the same marketplace.`,
        });
      }
    }
  }

  // --- a very new account ----------------------------------------------------
  for (const l of listings) {
    if (l.seller.memberSince === undefined) continue;
    const ageDays = (now / 1000 - l.seller.memberSince) / 86400;
    if (ageDays < NEW_ACCOUNT_DAYS) {
      flags.push({
        source: l.source,
        listingId: l.id,
        kind: "new_account",
        message: `Seller account is ${Math.max(0, Math.floor(ageDays))} days old.`,
      });
    }
  }

  return flags;
}

/**
 * Analyse a completed search.
 *
 * `results` must be EVERY source that was asked, including the ones that
 * failed — that is how this function knows whether its sample is trustworthy.
 * Passing only the successful ones defeats the entire safeguard.
 */
export function analyse(
  results: SourceResult[],
  opts: { currency?: string; now?: number; query?: string } = {},
): Analysis {
  const now = opts.now ?? Date.now();
  const listings = results.flatMap((r) => r.listings);
  const identities: Record<string, Identity> = {};
  for (const l of listings) identities[listingKey(l)] = identify(l.title, opts.query ?? "");
  const idOf = (l: Listing) => identities[listingKey(l)];

  const isComparable = (r: SourceResult) => r.comparable !== false;

  // Coverage is what the MEDIAN rests on, so it counts only comparable sources.
  // Listing a non-comparable source here would make "across 3 marketplaces"
  // claim a breadth the number does not have.
  const coverage = results.filter((r) => r.status === "ok" && isComparable(r)).map((r) => r.source);
  const excludedFromComparison = results
    .filter((r) => r.status === "ok" && !isComparable(r))
    .map((r) => r.source);
  const notConfigured = results.filter((r) => r.status === "not_configured").map((r) => r.source);
  // Only comparable sources that were expected to answer and failed. See
  // `notConfigured` and `degraded` on the Analysis type for why the others do
  // not block the comparison.
  const degraded = results
    .filter((r) => r.status !== "ok" && r.status !== "not_configured" && isComparable(r))
    .map((r) => ({ source: r.source, status: r.status, detail: r.detail }));

  // Every listing, comparable or not, still gets the checks that do not depend
  // on a price comparison. A two-day-old shop is two days old on any marketplace.
  const flags = coverageIndependentFlags(listings, now);

  if (degraded.length) {
    return {
      status: "incomplete_coverage",
      reason:
        `Price comparison is unavailable: ${degraded.map((d) => d.source).join(", ")} ` +
        `did not respond, so any median would be taken over a biased sample.`,
      coverage,
      flags,
      degraded,
      notConfigured,
      excludedFromComparison,
      priceChecked: [],
      comparisons: {},
      notCompared: {},
      identities,
      reportsChecked: false,
    };
  }

  // Compare like with like: only comparable sources, one currency, and one
  // CONDITION at a time. A handmade sleeve is not a cheap laptop, and a used
  // laptop is not a cheap new one.
  const pooled = results.filter((r) => r.status === "ok" && isComparable(r)).flatMap((r) => r.listings);
  const currency = opts.currency ?? pooled[0]?.price.currency;
  const sameCurrency = pooled.filter((l) => l.price.currency === currency);

  // Refurbished pools with new: it is sold as working-as-new, typically within
  // the price band the 0.5 ratio already tolerates. "unknown" pools with
  // nothing — a listing whose condition we cannot tell cannot be compared.
  // Accessories and for-parts items never enter a comparison: a charger is
  // not a cheap laptop, and a broken laptop is not a cheap working one.
  const notCompared: Record<string, string> = {};
  for (const l of sameCurrency) {
    const id = idOf(l);
    if (id.kind !== "product" && id.kindReason) notCompared[listingKey(l)] = id.kindReason;
  }
  // Only the category most of a marketplace's results share is compared. A
  // search for "PlayStation 5" returns consoles, games, controllers and spare
  // parts, and eBay files each under its own category: a 15-euro game priced
  // against 500-euro consoles is exactly the false alarm this module exists to
  // avoid. A listing whose marketplace publishes no category stays in.
  // A title that doesn't name the searched model (an "iPhone 12" in an
  // "iPhone 14" search, a remote player "für PS5") is never compared: there is
  // no telling what it is, and compared, it was either a false alarm or a
  // false "best deal".
  const name = opts.query?.trim();
  const candidates = sameCurrency.filter((l) => {
    if (idOf(l).kind !== "product") return false;
    if (name && idOf(l).named === false) {
      notCompared[listingKey(l)] = `Its title doesn't name the ${name}, so it isn't compared with listings that do.`;
      return false;
    }
    return true;
  });
  const mainBySource = new Map<string, { id: string; name: string } | undefined>();
  for (const source of new Set(candidates.map((l) => l.source))) {
    mainBySource.set(source, mainCategory(candidates.filter((l) => l.source === source)));
  }
  const products = candidates.filter((l) => {
    const main = mainBySource.get(l.source);
    if (!main || !l.category || l.category.id === main.id) return true;
    notCompared[listingKey(l)] = `Listed under "${l.category.name}", not "${main.name}" like most results, so its price isn't compared.`;
    return false;
  });

  // The demo feed's prices are made up, so they are never pooled with real
  // marketplace listings: each is compared only within its own world. Pooling
  // them would price real eBay listings against invented ones, and the other
  // way round.
  const worlds: { demo: boolean; listings: Listing[] }[] = [
    { demo: false, listings: products.filter((l) => l.source !== DEMO_SOURCE) },
    { demo: true, listings: products.filter((l) => l.source === DEMO_SOURCE) },
  ];
  const groups: { label: string; demo: boolean; listings: Listing[] }[] = worlds.flatMap((w) => [
    { label: "new", demo: w.demo, listings: w.listings.filter((l) => l.condition === "new" || l.condition === "refurbished") },
    { label: "used", demo: w.demo, listings: w.listings.filter((l) => l.condition === "used") },
  ]);

  // Scope the claim to what was actually searched. Saying "across marketplaces"
  // when one marketplace answered would overstate the evidence.
  const NAMES: Record<string, string> = { ebay: "eBay", amazon: "Amazon", etsy: "Etsy", feed: "the partner feed", stub: "the demo feed" };
  const realCoverage = coverage.filter((c) => c !== DEMO_SOURCE);
  const scopeOf = (demo: boolean) =>
    demo
      ? "on the demo feed"
      : realCoverage.length > 1
        ? `across ${realCoverage.length} marketplaces`
        : `on ${realCoverage[0] ? (NAMES[realCoverage[0]] ?? realCoverage[0]) : "this marketplace"}`;

  // The page's summary medians come from the real marketplaces when they have
  // enough listings, and from the demo feed only when nothing real does.
  const medians: Record<string, { median: number; sampleSize: number }> = {};
  const demoMedians: Record<string, { median: number; sampleSize: number }> = {};
  const priceChecked: string[] = [];
  const comparisons: Record<string, { sampleSize: number; median: number; scope?: string }> = {};

  for (const g of groups) {
    const scope = scopeOf(g.demo);
    // Too few in THIS group means no comparison for THIS group. Borrowing the
    // other group's median instead would be the used-vs-new mistake again.
    if (g.listings.length < MIN_SAMPLE) continue;
    (g.demo ? demoMedians : medians)[g.label] = { median: median(g.listings.map((l) => totalPrice(l).amount)), sampleSize: g.listings.length };

    for (const l of g.listings) {
      // Each listing against the listings that are the same product as it: an
      // X1 Carbon 512 GB is never priced against an X1 Yoga or a 1 TB unit.
      const same = g.listings.filter((o) => sameProduct(idOf(l), idOf(o)));
      if (same.length < MIN_SAMPLE) {
        notCompared[listingKey(l)] =
          `Only ${same.length} ${g.label === "used" ? "used " : ""}listing${same.length === 1 ? "" : "s"} of the same model and configuration, so its price isn't compared.`;
        continue;
      }
      const m = median(same.map((o) => totalPrice(o).amount));
      const underpriced = totalPrice(l).amount < m * UNDERPRICED_RATIO;
      comparisons[listingKey(l)] = { sampleSize: same.length, median: m, scope };
      priceChecked.push(listingKey(l));
      if (underpriced) {
        flags.push({
          source: l.source,
          listingId: l.id,
          kind: "underpriced",
          // Says what was measured, not what the seller is. The buyer decides.
          message:
            g.label === "used"
              ? `Priced well below the median of ${same.length} comparable used listings ${scope}.`
              : `Priced well below the median of ${same.length} comparable listings ${scope}.`,
        });
      }
    }
  }

  const common = {
    coverage, flags, degraded, notConfigured, excludedFromComparison, priceChecked, currency,
    comparisons, notCompared, identities, reportsChecked: false,
  };

  let medianScope = scopeOf(false);
  if (!medians.new && !medians.used) {
    Object.assign(medians, demoMedians);
    medianScope = scopeOf(true);
  }
  if (!medians.new && !medians.used) {
    const count = (label: string) => groups.filter((g) => g.label === label).reduce((n, g) => n + g.listings.length, 0);
    return {
      status: "insufficient_sample",
      reason:
        `Only ${count("new")} new and ${count("used")} used comparable listing(s); ` +
        `at least ${MIN_SAMPLE} of one condition are needed before a price is worth comparing.`,
      ...common,
    };
  }

  return {
    status: "ok",
    medianScope,
    median: medians.new?.median,
    sampleSize: medians.new?.sampleSize,
    used: medians.used,
    ...common,
  };
}
