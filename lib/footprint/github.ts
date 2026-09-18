/**
 * lib/footprint/github.ts
 *
 * GitHub signal collection. This is the strongest of the three platforms by a
 * wide margin: the API is free, unauthenticated, and exposes signals that other
 * people generated.
 *
 * THE SIGNAL THAT MATTERS
 * `merged_prs_external` — pull requests this user authored that were merged into
 * repositories they do NOT own. Someone else had to review and press merge. You
 * cannot manufacture it alone, you cannot backdate it, and you cannot buy it in
 * bulk. Everything else here is supporting evidence.
 *
 * WHAT IS DELIBERATELY WEIGHTED LOW
 * Contribution counts and repo counts are trivially faked — `git commit --date`
 * backdates history in one command, and an empty repo costs nothing. They are
 * collected because their ABSENCE is informative, not because their presence
 * proves much.
 */

import type { Platform, PlatformReport, Signal } from "./types";

const API = "https://api.github.com";
const PLATFORM: Platform = "github";

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "gillty-verify",
  };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/**
 * Heavy-tailed counts (stars, followers) need a log curve, or one popular repo
 * saturates the score and a genuine mid-size account looks identical to a bot.
 * `saturateAt` is the value that scores ~1.0.
 */
function logNorm(value: number, saturateAt: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(saturateAt));
}

function yearsSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (365.25 * 24 * 3600 * 1000);
}

export async function collectGithub(
  handle: string,
  ownershipProven: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformReport> {
  const collectedAt = Date.now();
  const base: Omit<PlatformReport, "status" | "signals"> = {
    platform: PLATFORM,
    handle,
    ownershipProven,
    collectedAt,
  };

  // Signals from an account the user has not proven they control are worthless —
  // anyone can type "torvalds" into a form. Collect nothing and say why.
  if (!ownershipProven) {
    return {
      ...base,
      status: "ownership_unproven",
      signals: [],
      detail: "Account control not proven; signals not collected.",
    };
  }

  try {
    const userRes = await fetchImpl(`${API}/users/${encodeURIComponent(handle)}`, {
      headers: headers(),
    });

    if (userRes.status === 403 || userRes.status === 429) {
      return { ...base, status: "rate_limited", signals: [], detail: "GitHub rate limit reached." };
    }
    if (userRes.status === 404) {
      return { ...base, status: "error", signals: [], detail: `No such user: ${handle}` };
    }
    if (!userRes.ok) {
      return { ...base, status: "error", signals: [], detail: `GitHub returned ${userRes.status}.` };
    }

    const user = (await userRes.json()) as {
      created_at: string;
      followers: number;
      public_repos: number;
      name?: string | null;
      bio?: string | null;
    };

    const signals: Signal[] = [];
    const ageYears = yearsSince(user.created_at);

    signals.push({
      id: "github.account_age_years",
      platform: PLATFORM,
      kind: "temporal",
      label: "GitHub account age",
      value: Number(ageYears.toFixed(1)),
      // 5 years reads as a well-established account.
      normalised: Math.min(1, ageYears / 5),
      // Halved after the 2026-09-18 benchmark. Age is context, not evidence —
      // an old empty account is what a dormant purchased account looks like.
      // The corroboration gate in score.ts is the hard backstop; this stops age
      // dominating the weighted average even for accounts that clear the gate.
      weight: 0.5,
    });

    signals.push({
      id: "github.followers",
      platform: PLATFORM,
      kind: "corroborated",
      label: "Followers",
      value: user.followers,
      normalised: logNorm(user.followers, 500),
      // Cut from 0.8 to 0.3 after the 2026-09-18 benchmark. Followers are
      // corroborated only in the weakest sense: they are openly purchasable in
      // bulk, so a follower count is closer to a self-generated signal than to
      // evidence someone reviewed your work. A merged PR (2.0) cannot be bought.
      weight: 0.3,
    });

    signals.push({
      id: "github.public_repos",
      platform: PLATFORM,
      kind: "self_asserted",
      label: "Public repositories",
      value: user.public_repos,
      normalised: logNorm(user.public_repos, 40),
      // Deliberately low: an empty repo costs nothing to create.
      weight: 0.3,
    });

    // --- Stars received across own repos (corroborated) ---
    const reposRes = await fetchImpl(
      `${API}/users/${encodeURIComponent(handle)}/repos?per_page=100&sort=updated`,
      { headers: headers() },
    );
    if (reposRes.ok) {
      const repos = (await reposRes.json()) as Array<{ stargazers_count: number; fork: boolean }>;
      // Forks inherit their parent's stars in some views; exclude them so a
      // fork of a popular project does not read as the user's own traction.
      const stars = repos
        .filter((r) => !r.fork)
        .reduce((sum, r) => sum + (r.stargazers_count || 0), 0);

      signals.push({
        id: "github.stars_received",
        platform: PLATFORM,
        kind: "corroborated",
        label: "Stars on own repositories",
        value: stars,
        normalised: logNorm(stars, 200),
        weight: 1.0,
      });
    }

    // --- THE signal: merged PRs into repos the user does not own ---
    // The search API has a much tighter rate limit than the core API (about
    // 10 req/min), so this is one request and we accept the count only.
    const q = `is:pr author:${handle} is:merged -user:${handle}`;
    const prRes = await fetchImpl(
      `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=1`,
      { headers: headers() },
    );
    if (!prRes.ok) {
      // SILENT-DROP BUG, found by the 2026-09-18 benchmark: this branch used to
      // do nothing. The search API rate-limits far sooner than the core API
      // (~10/min unauthenticated), so the heaviest-weighted signal in the whole
      // model vanished and the score was computed from what remained — quietly,
      // with no indication anything was missing. Every benchmark number was wrong.
      //
      // That is exactly the failure this project forbids: "could not check" was
      // being folded into the score instead of surfaced. Report it instead.
      return {
        ...base,
        status: prRes.status === 403 || prRes.status === 429 ? "rate_limited" : "error",
        signals,
        detail:
          `Merged-PR search unavailable (HTTP ${prRes.status}). This is the ` +
          `heaviest-weighted signal, so no score is issued without it. Set ` +
          `GITHUB_TOKEN to raise the search rate limit.`,
      };
    }

    {
      const pr = (await prRes.json()) as { total_count: number };
      signals.push({
        id: "github.merged_prs_external",
        platform: PLATFORM,
        kind: "corroborated",
        label: "Merged PRs in others' repositories",
        value: pr.total_count,
        // Benchmarked 2026-09-18: a ceiling of 50 made 72, 235, 1074 and 1412
        // merged PRs score identically. 400 keeps the top of the range spread
        // while still treating ~50 as clearly substantial.
        normalised: logNorm(pr.total_count, 400),
        // The heaviest weight in the whole model. Another human approved these.
        weight: 2.0,
      });
    }

    return { ...base, status: "ok", signals };
  } catch (err) {
    return {
      ...base,
      status: "error",
      signals: [],
      detail: err instanceof Error ? err.message : "Unknown error collecting GitHub signals.",
    };
  }
}
