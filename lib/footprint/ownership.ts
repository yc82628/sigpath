/**
 * lib/footprint/ownership.ts
 *
 * Proving a user controls an account, without scraping anything.
 *
 * THE PATTERN
 * The server issues a short-lived nonce. The user publishes it somewhere only
 * the account holder could put it. The server checks it is there. That proves
 * CONTROL — which is the only thing we actually need — and it never requires us
 * to read a profile, scrape a page, or breach anyone's terms of service.
 *
 * WHY NOT JUST SCRAPE
 * LinkedIn has no public profile API, blocks scrapers aggressively, and forbids
 * scraping in its terms. X's read API is paid. Any demo built on scraping those
 * two will break — probably during the demo. Ownership proof sidesteps both
 * problems and is strictly stronger evidence anyway: a scraped profile proves a
 * profile exists, not that the person in front of you owns it.
 *
 * PER-PLATFORM REALITY — the mechanisms are NOT equally strong, and the UI must
 * say so rather than showing three identical green ticks:
 *
 *   GitHub   public gist containing the nonce, read via the free public API.
 *            Strong. No auth, no rate-limit pain, fully verifiable server-side.
 *
 *   X        public post containing the nonce, resolved via the free oEmbed
 *            endpoint. Moderate — oEmbed can refuse protected or deleted posts,
 *            and it is not a stable contract. Degrade honestly when it fails.
 *
 *   LinkedIn OAuth ("Sign in with LinkedIn"), NOT a published nonce. There is no
 *            reliable way to read a public LinkedIn post server-side; the auth
 *            wall will defeat it. OAuth returns a verified name and subject id
 *            straight from LinkedIn, which is better evidence than a nonce.
 *            It is a different mechanism and this module models it as such.
 */

import { randomBytes } from "crypto";
import type { Platform } from "./types";

/** Nonces are short-lived: a stale proof is a proof someone else may have found. */
export const OWNERSHIP_TTL_SECONDS = 30 * 60; // 30 minutes

/** Prefix makes the string searchable and obviously purposeful in a public post. */
const NONCE_PREFIX = "gillty-verify";

export interface OwnershipChallenge {
  challengeId: string;
  platform: Platform;
  /** The exact string the user must publish. */
  nonce: string;
  /** What to tell the user to do, verbatim. */
  instruction: string;
  expiresAt: number;
}

export type OwnershipMethod = "published_nonce" | "oauth";

export function methodFor(platform: Platform): OwnershipMethod {
  return platform === "linkedin" ? "oauth" : "published_nonce";
}

export function buildOwnershipChallenge(platform: Platform): OwnershipChallenge {
  const challengeId = randomBytes(8).toString("hex");
  const nonce = `${NONCE_PREFIX}-${randomBytes(6).toString("hex")}`;
  const expiresAt = Date.now() + OWNERSHIP_TTL_SECONDS * 1000;

  const instruction =
    platform === "github"
      ? `Create a PUBLIC gist containing exactly this text: ${nonce}`
      : platform === "x"
        ? `Post this publicly on X, then paste the post URL: ${nonce}`
        : `Sign in with LinkedIn to confirm you control the account.`;

  return { challengeId, platform, nonce, instruction, expiresAt };
}

export function isExpired(c: Pick<OwnershipChallenge, "expiresAt">, now = Date.now()): boolean {
  return now > c.expiresAt;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface OwnershipResult {
  proven: boolean;
  method: OwnershipMethod;
  /** Confidence in the mechanism itself, independent of whether it passed. */
  strength: "strong" | "moderate" | "unavailable";
  /** Operator-facing. Never show the raw reason to the client verbatim. */
  detail: string;
  /** Canonical handle as the platform reports it, if we learned it. */
  resolvedHandle?: string;
}

/**
 * GitHub: list the user's public gists and look for the nonce.
 *
 * Unauthenticated this endpoint allows 60 requests/hour per IP, which is fine
 * for a demo but WILL rate-limit under load — set GITHUB_TOKEN to raise it to
 * 5,000/hr. We surface rate limiting rather than reporting a false negative,
 * because "we could not check" and "they failed the check" are very different
 * claims to make about someone.
 */
export async function verifyGithubOwnership(
  handle: string,
  nonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnershipResult> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "gillty-verify",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetchImpl(
    `https://api.github.com/users/${encodeURIComponent(handle)}/gists?per_page=20`,
    { headers },
  );

  if (res.status === 403 || res.status === 429) {
    return {
      proven: false,
      method: "published_nonce",
      strength: "unavailable",
      detail: "GitHub rate limit reached. Set GITHUB_TOKEN to raise the ceiling.",
    };
  }
  if (res.status === 404) {
    return {
      proven: false,
      method: "published_nonce",
      strength: "strong",
      detail: `No such GitHub user: ${handle}`,
    };
  }
  if (!res.ok) {
    return {
      proven: false,
      method: "published_nonce",
      strength: "unavailable",
      detail: `GitHub returned ${res.status}.`,
    };
  }

  const gists = (await res.json()) as Array<{
    description?: string | null;
    files?: Record<string, { filename?: string }>;
  }>;

  // Match on the description or any filename. We deliberately do NOT fetch each
  // gist's content: that is N more requests against a 60/hr budget, and putting
  // the nonce in the description or filename is just as strong a proof.
  const found = gists.some((g) => {
    if (g.description && g.description.includes(nonce)) return true;
    return Object.keys(g.files ?? {}).some((f) => f.includes(nonce));
  });

  return {
    proven: found,
    method: "published_nonce",
    strength: "strong",
    detail: found ? "Nonce found in a public gist." : "Nonce not found in the 20 most recent public gists.",
    resolvedHandle: handle,
  };
}

/**
 * X: resolve the submitted post URL through the free oEmbed endpoint and look
 * for the nonce in the returned HTML.
 *
 * HONEST LIMIT — say this in the pitch: oEmbed is not a supported stable API for
 * this purpose, it fails for protected accounts, and X may restrict it further.
 * Treat X ownership as MODERATE evidence and design the score so that losing it
 * degrades the result rather than breaking the flow.
 */
export async function verifyXOwnership(
  postUrl: string,
  nonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnershipResult> {
  let parsed: URL;
  try {
    parsed = new URL(postUrl);
  } catch {
    return { proven: false, method: "published_nonce", strength: "moderate", detail: "Not a valid URL." };
  }
  if (!/(^|\.)(x|twitter)\.com$/.test(parsed.hostname)) {
    return {
      proven: false,
      method: "published_nonce",
      strength: "moderate",
      detail: `Not an X post URL: ${parsed.hostname}`,
    };
  }

  const endpoint = `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(postUrl)}`;
  const res = await fetchImpl(endpoint, { headers: { "user-agent": "gillty-verify" } });

  if (!res.ok) {
    return {
      proven: false,
      method: "published_nonce",
      strength: "unavailable",
      detail: `oEmbed returned ${res.status} — post may be protected, deleted, or the endpoint restricted.`,
    };
  }

  const data = (await res.json()) as { html?: string; author_name?: string; author_url?: string };
  const html = data.html ?? "";
  const found = html.includes(nonce);

  // author_url looks like https://twitter.com/<handle>
  const resolvedHandle = data.author_url?.split("/").filter(Boolean).pop();

  return {
    proven: found,
    method: "published_nonce",
    strength: "moderate",
    detail: found ? "Nonce found in the post." : "Nonce not present in the post text.",
    resolvedHandle,
  };
}

/**
 * LinkedIn: there is no nonce to check. Ownership is established by completing
 * the OAuth flow; this function records the outcome of that flow.
 *
 * `subject` is the `sub` claim from LinkedIn's id_token — stable per user, and
 * the thing to store rather than the display name, which changes.
 */
export function recordLinkedinOwnership(
  subject: string | null,
  name?: string,
): OwnershipResult {
  if (!subject) {
    return {
      proven: false,
      method: "oauth",
      strength: "strong",
      detail: "LinkedIn OAuth not completed.",
    };
  }
  return {
    proven: true,
    method: "oauth",
    strength: "strong",
    detail: "LinkedIn OAuth completed; subject verified by LinkedIn.",
    resolvedHandle: name,
  };
}
