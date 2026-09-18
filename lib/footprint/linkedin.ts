/**
 * lib/footprint/linkedin.ts
 *
 * LinkedIn signal collection.
 *
 * WHY THERE IS NO SCRAPER HERE, AND WHY THERE NEVER SHOULD BE
 * LinkedIn has no public profile API. Their terms forbid scraping, they detect
 * and block it aggressively, and a demo built on it will fail at the worst
 * possible moment. Do not add one. If someone suggests it in a review, the
 * answer is that hiQ v. LinkedIn did not make it contractually permitted and it
 * is operationally unreliable regardless.
 *
 * WHAT WE USE INSTEAD
 * "Sign in with LinkedIn using OpenID Connect" — the standard OAuth product.
 * The id_token gives a verified `sub` (stable per user), `name`, `email_verified`
 * and, on some app configurations, a `picture`. LinkedIn itself asserts these,
 * which is strictly stronger evidence than anything scraped from a public page:
 * a scraped profile proves a profile exists, not that the person in front of you
 * owns it.
 *
 * LIKE x.ts, THIS IS DELIBERATELY THIN.
 * OIDC returns identity, not standing — no connection count, no tenure, no
 * endorsements. So LinkedIn contributes BREADTH and NAME AGREEMENT (45% of the
 * score between them) rather than depth. `email_verified` is the one extra
 * signal worth having, because a third party vouched for it.
 *
 * SETUP (do this once, in the LinkedIn Developer console):
 *   1. Create an app, request the "Sign In with LinkedIn using OpenID Connect" product
 *   2. Add your redirect URL
 *   3. Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET
 * Scopes needed: `openid profile email` — nothing more.
 */

import type { Platform, PlatformReport, Signal } from "./types";

const PLATFORM: Platform = "linkedin";

/** The subset of LinkedIn's OIDC userinfo response we actually use. */
export interface LinkedinIdentity {
  /** Stable subject id. Store THIS, not the display name — names change. */
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
}

export const LINKEDIN_SCOPES = "openid profile email";
export const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

/**
 * Exchange the OAuth code for an access token, then fetch userinfo.
 * Returns null if any step fails — the caller reports that as
 * `ownership_unproven`, never as evidence against the user.
 */
export async function exchangeLinkedinCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedinIdentity | null> {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const tokenRes = await fetchImpl(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!tokenRes.ok) return null;

  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) return null;

  const meRes = await fetchImpl(LINKEDIN_USERINFO_URL, {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!meRes.ok) return null;

  const me = (await meRes.json()) as LinkedinIdentity;
  return me.sub ? me : null;
}

export function collectLinkedin(identity: LinkedinIdentity | null): PlatformReport {
  const collectedAt = Date.now();

  if (!identity) {
    return {
      platform: PLATFORM,
      status: "ownership_unproven",
      ownershipProven: false,
      signals: [],
      detail: "LinkedIn sign-in not completed.",
      collectedAt,
    };
  }

  const signals: Signal[] = [
    {
      id: "linkedin.oidc_verified",
      platform: PLATFORM,
      kind: "corroborated",
      label: "Identity asserted by LinkedIn",
      value: identity.sub,
      normalised: 1,
      // LinkedIn is the third party doing the vouching here, which is why this
      // outweighs the equivalent X signal.
      weight: 1.0,
    },
  ];

  if (identity.email_verified) {
    signals.push({
      id: "linkedin.email_verified",
      platform: PLATFORM,
      kind: "corroborated",
      label: "Email verified by LinkedIn",
      value: true,
      normalised: 1,
      weight: 0.6,
    });
  }

  return {
    platform: PLATFORM,
    status: "ok",
    // Display name is what we compare for cross-platform agreement. `sub` is what
    // you persist.
    handle: identity.name,
    ownershipProven: true,
    signals,
    detail: "Depth signals unavailable — LinkedIn OIDC returns identity, not standing.",
    collectedAt,
  };
}
