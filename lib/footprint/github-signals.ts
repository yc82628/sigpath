/**
 * lib/footprint/github-signals.ts — turning raw GitHub counts into weighted signals.
 *
 * WHY THIS IS SEPARATE FROM github.ts
 * Scoring behaviour was only testable by making live API calls, which meant every
 * tuning experiment burned rate limit and every regression check needed the
 * network. Worse, GitHub's search endpoint limits at ~10/min, so a benchmark run
 * would half-complete and quietly report numbers from partial data.
 *
 * Fetching and interpreting are different jobs. github.ts fetches; this module
 * interprets. The collector and the tests both call `buildGithubSignals`, so the
 * tests exercise the real weighting rather than a reimplementation of it that
 * could drift.
 *
 * ALL WEIGHTS HERE ARE BENCHMARK-DERIVED. The comments say what evidence moved
 * each one. Do not adjust them by intuition — re-run scripts/benchmark-scoring.ts
 * and change them against measured cohort separation.
 */

import type { Platform, Signal } from "./types";

const PLATFORM: Platform = "github";

/**
 * Heavy-tailed counts need a log curve, or one popular repository saturates the
 * score and a genuine mid-size account looks identical to a bot. `saturateAt` is
 * the value that scores ~1.0.
 */
export function logNorm(value: number, saturateAt: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(saturateAt));
}

/** Raw observations, before any interpretation. */
export interface GithubRaw {
  accountAgeYears: number;
  followers: number;
  publicRepos: number;
  /** Stars across own, non-forked repositories. */
  starsReceived: number;
  /** PRs authored by this user, merged into repos they do NOT own. */
  mergedPrsExternal: number;
}

export function buildGithubSignals(raw: GithubRaw): Signal[] {
  return [
    {
      id: "github.account_age_years",
      platform: PLATFORM,
      kind: "temporal",
      label: "GitHub account age",
      value: Number(raw.accountAgeYears.toFixed(1)),
      // 5 years reads as well-established.
      normalised: Math.min(1, raw.accountAgeYears / 5),
      // Halved from 1.0 on 2026-09-18. Age is context, not evidence: a
      // 16-year-old account with 4 followers and no merged PRs was scoring 24
      // on age alone, and "old, plausible, inactive" is exactly what a dormant
      // purchased account looks like.
      weight: 0.5,
    },
    {
      id: "github.followers",
      platform: PLATFORM,
      kind: "corroborated",
      label: "Followers",
      value: raw.followers,
      normalised: logNorm(raw.followers, 500),
      // Cut from 0.8 on 2026-09-18. Followers are corroborated only in the
      // weakest sense — they are openly purchasable in bulk, so a follower count
      // sits closer to a self-generated signal than to evidence anyone reviewed
      // your work.
      weight: 0.3,
    },
    {
      id: "github.public_repos",
      platform: PLATFORM,
      kind: "self_asserted",
      label: "Public repositories",
      value: raw.publicRepos,
      normalised: logNorm(raw.publicRepos, 40),
      // Deliberately low: an empty repository costs nothing to create.
      weight: 0.3,
    },
    {
      id: "github.stars_received",
      platform: PLATFORM,
      kind: "corroborated",
      label: "Stars on own repositories",
      value: raw.starsReceived,
      normalised: logNorm(raw.starsReceived, 200),
      // Stars are buyable too, but at meaningfully higher cost than followers.
      weight: 1.0,
    },
    {
      id: "github.merged_prs_external",
      platform: PLATFORM,
      kind: "corroborated",
      label: "Merged PRs in others' repositories",
      value: raw.mergedPrsExternal,
      // Raised from 50 on 2026-09-18: at 50, accounts with 72, 235, 1074 and
      // 1412 merged PRs all scored identically, discarding real information at
      // the top of the range.
      normalised: logNorm(raw.mergedPrsExternal, 400),
      // The heaviest weight in the model. Another human had to review and press
      // merge — it cannot be self-manufactured, backdated, or bought in bulk.
      weight: 2.0,
    },
  ];
}
