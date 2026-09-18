/**
 * lib/footprint/x.ts
 *
 * X (Twitter) signal collection.
 *
 * READ THIS BEFORE EXPECTING RICH SIGNALS
 * X's read API is paid (Basic tier is ~$200/month at time of writing). Without
 * it there is no legitimate way to fetch follower counts, account age, or post
 * history server-side. Scraping x.com breaches their terms and will be blocked.
 *
 * So this collector is DELIBERATELY THIN. It contributes almost nothing to the
 * depth term of the score, and that is the honest outcome rather than a bug.
 * What it does contribute is significant anyway:
 *
 *   - BREADTH: a third proven platform (30% of the total score)
 *   - NAME AGREEMENT: the handle can be compared against the others (15%)
 *
 * Together that is 45% of the model, earned purely by proving the same person
 * controls three independent accounts. That is exactly the expensive-to-fake
 * property this whole design is built around — so a thin collector is fine.
 *
 * IF YOU LATER BUY API ACCESS
 * Add `created_at`, `followers_count` and `tweet_count` from GET /2/users/by
 * (user.fields=created_at,public_metrics) as `temporal` and `corroborated`
 * signals. The shape below is ready for them; nothing else needs to change.
 */

import type { Platform, PlatformReport, Signal } from "./types";

const PLATFORM: Platform = "x";

export interface XCollectionInput {
  /** Handle, without the leading @. Usually resolved from the ownership proof. */
  handle: string;
  ownershipProven: boolean;
  /** The post URL used as the ownership proof, if we have it. */
  proofUrl?: string;
}

export async function collectX(input: XCollectionInput): Promise<PlatformReport> {
  const { handle, ownershipProven, proofUrl } = input;
  const collectedAt = Date.now();

  const base: Omit<PlatformReport, "status" | "signals"> = {
    platform: PLATFORM,
    handle,
    ownershipProven,
    collectedAt,
  };

  if (!ownershipProven) {
    return {
      ...base,
      status: "ownership_unproven",
      signals: [],
      detail: "Account control not proven; nothing collected.",
    };
  }

  const signals: Signal[] = [];

  // The one thing we genuinely learn without paid access: this person published
  // a server-issued nonce from this account, within the challenge window. That
  // is a corroborated fact about account control — modest, but real.
  signals.push({
    id: "x.control_demonstrated",
    platform: PLATFORM,
    kind: "corroborated",
    label: "Published a server-issued code from this account",
    value: proofUrl ?? true,
    normalised: 1,
    // Low weight: it proves control, not standing. Breadth and name agreement
    // are where this platform actually earns its keep, and those are computed
    // across reports in score.ts rather than here.
    weight: 0.5,
  });

  return {
    ...base,
    status: "ok",
    signals,
    detail:
      "Depth signals unavailable without paid X API access. This platform contributes breadth and name agreement.",
  };
}
