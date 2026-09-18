import { test } from "node:test";
import assert from "node:assert";
import { buildGithubSignals, type GithubRaw } from "../lib/footprint/github-signals";
import { computeFootprintScore } from "../lib/footprint/score";
import type { PlatformReport } from "../lib/footprint/types";

/**
 * Offline separation tests.
 *
 * These exist because tuning the weights previously required live GitHub calls,
 * which rate-limit at ~10/min on the search endpoint. That made every experiment
 * slow, and — worse — a half-completed run silently reported numbers computed
 * from partial data.
 *
 * The fixtures below are modelled on real accounts measured on 2026-09-18, so
 * they are not invented: they are that observed data, frozen so regressions are
 * detectable without the network.
 *
 * These assert SEPARATION between cohorts, not absolute scores. Absolute values
 * will move as weights are tuned; what must not regress is the ordering and the
 * size of the gaps.
 */

function report(raw: GithubRaw, handle = "subject"): PlatformReport {
  return {
    platform: "github",
    status: "ok",
    handle,
    ownershipProven: true,
    signals: buildGithubSignals(raw),
    collectedAt: Date.now(),
  };
}

function scoreOf(raw: GithubRaw): number {
  return computeFootprintScore([report(raw)]).score;
}

// Modelled on real accounts observed 2026-09-18.
const DEEP: GithubRaw = {
  accountAgeYears: 16.7, followers: 83987, publicRepos: 1100,
  starsReceived: 400000, mergedPrsExternal: 1074,
};
const POPULAR_NO_COLLAB: GithubRaw = {
  accountAgeYears: 15.6, followers: 24103, publicRepos: 8,
  starsReceived: 20926, mergedPrsExternal: 0,
};
const BOT: GithubRaw = {
  accountAgeYears: 9.4, followers: 5015, publicRepos: 0,
  starsReceived: 0, mergedPrsExternal: 0,
};
const THIN: GithubRaw = {
  accountAgeYears: 16.7, followers: 4, publicRepos: 2,
  starsReceived: 0, mergedPrsExternal: 0,
};
const FRESH_FAKE: GithubRaw = {
  accountAgeYears: 0.05, followers: 0, publicRepos: 3,
  starsReceived: 0, mergedPrsExternal: 0,
};

// ---------------------------------------------------------------------------
// Ordering — the cohorts must rank correctly
// ---------------------------------------------------------------------------

test("deep contributors outrank popular-but-uncollaborative accounts", () => {
  assert.ok(
    scoreOf(DEEP) > scoreOf(POPULAR_NO_COLLAB),
    `deep=${scoreOf(DEEP)} popular=${scoreOf(POPULAR_NO_COLLAB)}`,
  );
});

test("popular-but-uncollaborative outranks bots", () => {
  assert.ok(scoreOf(POPULAR_NO_COLLAB) > scoreOf(BOT));
});

test("bots outrank empty accounts", () => {
  assert.ok(scoreOf(BOT) >= scoreOf(THIN));
});

// ---------------------------------------------------------------------------
// Separation — ordering alone is not enough if the gaps are trivial
// ---------------------------------------------------------------------------

test("deep-to-thin separation is at least 40 points", () => {
  const gap = scoreOf(DEEP) - scoreOf(THIN);
  assert.ok(gap >= 40, `separation was only ${gap} points (deep=${scoreOf(DEEP)} thin=${scoreOf(THIN)})`);
});

test("merged PRs alone move the score by at least 25 points", () => {
  // Isolates the heaviest signal: identical accounts, one with a PR history.
  const without = scoreOf({ ...POPULAR_NO_COLLAB, mergedPrsExternal: 0 });
  const with_ = scoreOf({ ...POPULAR_NO_COLLAB, mergedPrsExternal: 500 });
  assert.ok(with_ - without >= 25, `PR history moved the score only ${with_ - without} points`);
});

// ---------------------------------------------------------------------------
// The properties that make the model defensible
// ---------------------------------------------------------------------------

test("age alone cannot lift an account above the corroboration cap", () => {
  // The dormant-purchased-account profile: old, plausible, no third party ever acted.
  const ancient = scoreOf({ ...THIN, accountAgeYears: 20 });
  assert.ok(ancient <= 10, `an empty 20-year-old account scored ${ancient}`);
});

test("repository count alone cannot lift a score", () => {
  // Empty repos are free to create — 500 of them must prove nothing.
  const spammy = scoreOf({ ...FRESH_FAKE, publicRepos: 500 });
  assert.ok(spammy <= 10, `500 empty repos scored ${spammy}`);
});

test("followers alone cannot clear the corroboration floor", () => {
  // Followers are purchasable in bulk; buying them must not buy a score.
  const bought = scoreOf({ ...THIN, followers: 100000 });
  assert.ok(bought <= 20, `100k bought followers scored ${bought}`);
});

test("a brand new empty account scores near zero", () => {
  assert.ok(scoreOf(FRESH_FAKE) <= 10, `fresh fake scored ${scoreOf(FRESH_FAKE)}`);
});

// ---------------------------------------------------------------------------
// Breadth must add real signal, not a constant
// ---------------------------------------------------------------------------

test("a single platform earns no flat breadth bonus", () => {
  // Previously every single-platform subject got +10 regardless of evidence,
  // which compressed the whole usable range and added nothing to separation.
  const empty = computeFootprintScore([report(FRESH_FAKE)]).score;
  assert.ok(empty <= 10, `an empty single-platform subject scored ${empty}`);
});

test("more proven platforms raises the score for identical evidence", () => {
  const one = computeFootprintScore([report(DEEP, "alice")]).score;
  const three = computeFootprintScore([
    report(DEEP, "alice"),
    { ...report(DEEP, "alice"), platform: "x" },
    { ...report(DEEP, "alice"), platform: "linkedin" },
  ]).score;
  assert.ok(three > one, `one=${one} three=${three} — breadth must still count`);
});
