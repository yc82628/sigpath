/**
 * lib/footprint/index.ts
 *
 * Orchestrator: run every linked platform, then score across them.
 *
 * ORDER OF OPERATIONS MATTERS
 * Ownership is proven BEFORE any collection. Signals from an account nobody has
 * proven they control are worthless — anyone can type a famous handle into a
 * form — so an unproven platform is never collected, and never scored.
 *
 * Platforms are collected concurrently but failures are isolated: one platform
 * being rate-limited or down must not take the whole verification with it. Each
 * returns a report with its own status, and score.ts turns non-ok statuses into
 * `gaps` rather than penalties.
 */

import { collectGithub } from "./github";
import { collectX } from "./x";
import { collectLinkedin, type LinkedinIdentity } from "./linkedin";
import { computeFootprintScore } from "./score";
import type { FootprintScore, PlatformReport } from "./types";

export interface FootprintInput {
  github?: { handle: string; ownershipProven: boolean };
  x?: { handle: string; ownershipProven: boolean; proofUrl?: string };
  /** Result of the OIDC flow; null if the user did not complete it. */
  linkedin?: LinkedinIdentity | null;
}

/** A platform the user did not link at all. Distinct from one that failed. */
function notLinked(platform: PlatformReport["platform"]): PlatformReport {
  return {
    platform,
    status: "not_linked",
    ownershipProven: false,
    signals: [],
    collectedAt: Date.now(),
  };
}

export async function buildFootprint(input: FootprintInput): Promise<FootprintScore> {
  const tasks: Array<Promise<PlatformReport>> = [];

  tasks.push(
    input.github
      ? collectGithub(input.github.handle, input.github.ownershipProven)
      : Promise.resolve(notLinked("github")),
  );

  tasks.push(
    input.x
      ? collectX({
          handle: input.x.handle,
          ownershipProven: input.x.ownershipProven,
          proofUrl: input.x.proofUrl,
        })
      : Promise.resolve(notLinked("x")),
  );

  tasks.push(
    input.linkedin !== undefined
      ? Promise.resolve(collectLinkedin(input.linkedin))
      : Promise.resolve(notLinked("linkedin")),
  );

  // allSettled, not all: a thrown collector must degrade to an error report,
  // not abort the other two.
  const settled = await Promise.allSettled(tasks);
  const order: PlatformReport["platform"][] = ["github", "x", "linkedin"];

  const reports: PlatformReport[] = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          platform: order[i],
          status: "error" as const,
          ownershipProven: false,
          signals: [],
          detail: r.reason instanceof Error ? r.reason.message : "Collector threw.",
          collectedAt: Date.now(),
        },
  );

  return computeFootprintScore(reports);
}

export * from "./types";
export { computeFootprintScore, checkConsistency } from "./score";
export {
  buildOwnershipChallenge,
  verifyGithubOwnership,
  verifyXOwnership,
  recordLinkedinOwnership,
  methodFor,
  isExpired,
} from "./ownership";
