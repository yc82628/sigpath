/**
 * lib/footprint/types.ts
 *
 * Digital-footprint verification: shared vocabulary.
 *
 * THE CLAIM WE ARE ACTUALLY MAKING
 * Not "this person has a LinkedIn, therefore real". Presence is cheap: aged
 * accounts are openly sold, and `git commit --date` will backdate a contribution
 * graph in one command. What is expensive to fake is a footprint that is DEEP
 * (years of it), CONSISTENT (the same identity across platforms), and
 * CORROBORATED BY OTHERS (things third parties did that the subject cannot
 * unilaterally cause — a merged PR, a real follower, a review).
 *
 * So every signal below is scored on those three axes, and the ones another
 * person had to participate in are weighted hardest.
 *
 * WHY OWNERSHIP PROOF, NOT SCRAPING
 * We never scrape LinkedIn or X. LinkedIn has no public profile API and blocks
 * scrapers (and it breaches their terms); X's API is paid. Instead the user
 * publishes a server-issued nonce somewhere only the account holder could put
 * it. That proves CONTROL, which is the thing we actually care about, and it
 * works the same way on all three platforms.
 */

export type Platform = "github" | "linkedin" | "x";

/** How much weight a signal carries, and why. */
export type SignalKind =
  /** Subject can create this alone and cheaply. Weak. */
  | "self_asserted"
  /** Takes real elapsed time to accumulate. Moderate — but backdatable in some cases. */
  | "temporal"
  /** Required a third party to act. Strongest — cannot be self-manufactured. */
  | "corroborated";

export interface Signal {
  /** Stable id, e.g. "github.merged_prs_external". */
  id: string;
  platform: Platform;
  kind: SignalKind;
  /** Human-readable, shown in the score breakdown. */
  label: string;
  /** Raw observed value, for the "why" panel. */
  value: number | string | boolean;
  /** Normalised 0..1 contribution before weighting. */
  normalised: number;
  /** Multiplier applied to `normalised`. See WEIGHTS in score.ts. */
  weight: number;
}

/** Why a platform report might be incomplete. Surfaced, never hidden. */
export type PlatformStatus =
  | "ok"
  | "not_linked"
  | "ownership_unproven"
  | "api_unavailable"
  | "rate_limited"
  | "error";

export interface PlatformReport {
  platform: Platform;
  status: PlatformStatus;
  /** The handle/identifier the user claimed. */
  handle?: string;
  /** Did they prove they control it? Signals from an unproven account count for nothing. */
  ownershipProven: boolean;
  signals: Signal[];
  /** Operator-facing detail for non-ok statuses. */
  detail?: string;
  /** When this was collected, for cache/staleness display. */
  collectedAt: number;
}

export type Band = "insufficient" | "weak" | "moderate" | "strong";

export interface FootprintScore {
  /** 0..100. */
  score: number;
  band: Band;
  reports: PlatformReport[];
  /**
   * Plain-language reasons, shown to the user. A score with no explanation is
   * not actionable and not contestable — both of which matter when you are
   * telling someone their business looks untrustworthy.
   */
  reasons: string[];
  /** Platforms that contributed nothing, and why. */
  gaps: string[];
  computedAt: number;
}

/**
 * Cross-platform consistency. Computed across reports rather than within one,
 * because agreement between independent sources is the part that is hard to
 * manufacture.
 */
export interface ConsistencyCheck {
  /** Same display name across proven platforms? */
  nameAgreement: number; // 0..1
  /** Do the account ages cluster, or is one suspiciously new? */
  ageSpreadYears: number;
  /** Count of platforms with proven ownership. */
  provenPlatforms: number;
}
