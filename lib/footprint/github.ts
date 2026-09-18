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

import type { Platform, PlatformReport } from "./types";
import { buildGithubSignals } from "./github-signals";

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

    const ageYears = yearsSince(user.created_at);

    // --- Stars received across own repos ---
    let starsReceived = 0;
    const reposRes = await fetchImpl(
      `${API}/users/${encodeURIComponent(handle)}/repos?per_page=100&sort=updated`,
      { headers: headers() },
    );
    if (reposRes.ok) {
      const repos = (await reposRes.json()) as Array<{ stargazers_count: number; fork: boolean }>;
      // Forks inherit their parent's stars in some views; exclude them so a fork
      // of a popular project does not read as this user's own traction.
      starsReceived = repos
        .filter((r) => !r.fork)
        .reduce((sum, r) => sum + (r.stargazers_count || 0), 0);
    }

    // --- The heaviest signal: merged PRs into repos the user does not own ---
    // The search API rate-limits far sooner than the core API (~10/min
    // unauthenticated), so this is a single request for the count only.
    const q = `is:pr author:${handle} is:merged -user:${handle}`;
    const prRes = await fetchImpl(
      `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=1`,
      { headers: headers() },
    );
    if (!prRes.ok) {
      // SILENT-DROP BUG, found by the 2026-09-18 benchmark: this branch used to
      // do nothing, so when the search rate-limited the model's heaviest signal
      // simply vanished and a score was computed from what remained — quietly,
      // with no indication anything was missing.
      //
      // That is the failure this project forbids: "could not check" was being
      // folded into the score instead of surfaced. Refuse to score instead.
      return {
        ...base,
        status: prRes.status === 403 || prRes.status === 429 ? "rate_limited" : "error",
        signals: [],
        detail:
          `Merged-PR search unavailable (HTTP ${prRes.status}). This is the ` +
          `heaviest-weighted signal, so no score is issued without it. Set ` +
          `GITHUB_TOKEN to raise the search rate limit.`,
      };
    }
    const { total_count: mergedPrsExternal } = (await prRes.json()) as { total_count: number };

    // Interpretation lives in github-signals.ts so the tests exercise the real
    // weighting rather than a copy of it that can drift.
    const signals = buildGithubSignals({
      accountAgeYears: ageYears,
      followers: user.followers,
      publicRepos: user.public_repos,
      starsReceived,
      mergedPrsExternal,
    });

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
