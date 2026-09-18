/**
 * lib/footprint/score.ts
 *
 * Turn platform reports into one score, plus the reasons behind it.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. "We could not check" is NEVER scored as "they failed." A rate limit, a
 *    dead API or a protected post is our problem, not evidence against the
 *    user. Those reduce CONFIDENCE and appear in `gaps`; they do not push the
 *    score down. Getting this wrong means telling a legitimate business they
 *    look fraudulent because GitHub throttled us.
 *
 * 2. Every score carries its reasons. A number with no explanation cannot be
 *    contested, and this number may be the reason someone refuses to deal with
 *    a real company. The `reasons` array is not decoration.
 *
 * WHY CONSISTENCY IS SCORED SEPARATELY
 * One deep profile is worth less than three shallow ones that agree. Faking a
 * single platform is cheap; faking three that corroborate each other, with
 * matching names and comparable account ages, is the expensive part. The
 * cross-platform term is where most of the actual anti-fraud value lives.
 */

import type {
  Band,
  ConsistencyCheck,
  FootprintScore,
  PlatformReport,
  Signal,
} from "./types";

/** Score below this and we decline to make a claim at all. */
const MIN_PROVEN_PLATFORMS = 1;

const BANDS: Array<{ min: number; band: Band }> = [
  { min: 75, band: "strong" },
  { min: 50, band: "moderate" },
  { min: 25, band: "weak" },
  { min: 0, band: "insufficient" },
];

function bandFor(score: number): Band {
  return BANDS.find((b) => score >= b.min)?.band ?? "insufficient";
}

function weightedAverage(signals: Signal[]): number {
  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  if (totalWeight === 0) return 0;
  return signals.reduce((s, x) => s + x.normalised * x.weight, 0) / totalWeight;
}

/** Cheap token-level name comparison — good enough to catch "Yu Chuan" vs "crypto_king_420". */
function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const setX = new Set(x.split(""));
  const overlap = [...new Set(y.split(""))].filter((c) => setX.has(c)).length;
  return overlap / Math.max(setX.size, 1);
}

export function checkConsistency(reports: PlatformReport[]): ConsistencyCheck {
  const proven = reports.filter((r) => r.ownershipProven && r.status === "ok");

  const names = proven.map((r) => r.handle).filter((h): h is string => !!h);
  let nameAgreement = 0;
  if (names.length > 1) {
    const pairs: number[] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        pairs.push(nameSimilarity(names[i], names[j]));
      }
    }
    nameAgreement = pairs.reduce((a, b) => a + b, 0) / pairs.length;
  } else if (names.length === 1) {
    // Nothing to compare against. Not agreement, not disagreement.
    nameAgreement = 0;
  }

  const ages = proven
    .map((r) => r.signals.find((s) => s.id.endsWith("account_age_years"))?.value)
    .filter((v): v is number => typeof v === "number");
  const ageSpreadYears = ages.length > 1 ? Math.max(...ages) - Math.min(...ages) : 0;

  return { nameAgreement, ageSpreadYears, provenPlatforms: proven.length };
}

export function computeFootprintScore(reports: PlatformReport[]): FootprintScore {
  const computedAt = Date.now();
  const reasons: string[] = [];
  const gaps: string[] = [];

  const usable = reports.filter((r) => r.ownershipProven && r.status === "ok");

  // --- Gaps: record why each platform contributed nothing. Never scored as failure. ---
  for (const r of reports) {
    if (usable.includes(r)) continue;
    switch (r.status) {
      case "not_linked":
        gaps.push(`${r.platform}: not linked.`);
        break;
      case "ownership_unproven":
        gaps.push(`${r.platform}: account control not proven, so its signals were ignored.`);
        break;
      case "rate_limited":
      case "api_unavailable":
        gaps.push(`${r.platform}: could not be checked (${r.detail ?? "API unavailable"}). This did not reduce the score.`);
        break;
      case "error":
        gaps.push(`${r.platform}: check failed (${r.detail ?? "error"}). This did not reduce the score.`);
        break;
    }
  }

  if (usable.length < MIN_PROVEN_PLATFORMS) {
    return {
      score: 0,
      band: "insufficient",
      reports,
      reasons: ["No platform ownership was proven, so no claim can be made."],
      gaps,
      computedAt,
    };
  }

  // --- Per-platform strength -------------------------------------------------
  // Corroborated evidence DRIVES the score; context only modulates it.
  //
  // Benchmarked 2026-09-18. A flat weighted average over all signals diluted the
  // thing that matters: total weight is 4.1, so even a maxed merged-PR signal
  // contributed only 2.0/4.1 = 49% of the term. Meanwhile account age and repo
  // count normalise near 1.0 for ANY old account, so weak evidence propped up
  // the floor while strong evidence was averaged down. Cohort separation stalled
  // at 28 points.
  //
  // Splitting them means an account with no third-party evidence cannot reach a
  // middling score on age alone, and one with a deep merged-PR history is not
  // dragged down by having few followers.
  const allSignals = usable.flatMap((r) => r.signals);
  const corroboratedSignals = allSignals.filter((s) => s.kind === "corroborated");
  const contextSignals = allSignals.filter((s) => s.kind !== "corroborated");

  const platformTerm =
    weightedAverage(corroboratedSignals) * 0.85 + weightedAverage(contextSignals) * 0.15;

  // --- Cross-platform consistency ---
  const consistency = checkConsistency(reports);
  // (n - 1) / 2, NOT n / 3. The old form gave every single-platform subject a
  // flat +10 — a constant, which adds nothing to separation and merely
  // compressed the usable range into 10..65. One platform now earns no breadth
  // credit at all, which is the honest reading: one profile is the cheapest
  // thing to fake, so it should score on its own evidence alone.
  const breadthTerm = Math.min(1, Math.max(0, (consistency.provenPlatforms - 1) / 2));
  const agreementTerm = consistency.nameAgreement;

  // Weighting: platform depth 55%, breadth 30%, name agreement 15%. Breadth is
  // heavy because "three platforms that agree" is the expensive thing to fake.
  const raw = platformTerm * 0.55 + breadthTerm * 0.3 + agreementTerm * 0.15;
  let score = Math.round(Math.max(0, Math.min(1, raw)) * 100);

  // --- Corroboration gate ---------------------------------------------------
  // Benchmarked 2026-09-18. Without this, a 16-year-old GitHub account with 4
  // followers and zero merged PRs scored 24, and one with 77 followers scored
  // 34 — account age and repo count were generating that score by themselves.
  //
  // That is wrong in the direction that matters most: "old, plausible-looking,
  // no corroboration" is exactly the profile of a dormant purchased account.
  // Age is NECESSARY but never SUFFICIENT; it must not produce score alone.
  //
  // So an account where no third party demonstrably acted is hard-capped,
  // however old it is and however many empty repositories it holds.
  const corroboratedWeight = allSignals
    .filter((s) => s.kind === "corroborated")
    .reduce((sum, s) => sum + s.normalised * s.weight, 0);

  // A THRESHOLD, not `=== 0`. The first version of this gate tested for zero and
  // never fired: an account with 4 followers has a non-zero corroborated signal,
  // so it sailed through and still scored 19. Trivial amounts of the weakest,
  // most purchasable signal must not buy passage.
  //
  // 0.5 is calibrated so that followers alone cannot clear it (max 1.0 x 0.3),
  // while any real merged-PR or stars history clears it easily.
  const CORROBORATION_FLOOR = 0.5;
  const NO_CORROBORATION_CAP = 10;
  const gated = corroboratedWeight < CORROBORATION_FLOOR && score > NO_CORROBORATION_CAP;
  if (gated) score = NO_CORROBORATION_CAP;

  // --- Reasons: lead with the corroborated signals, they are the real evidence ---
  if (gated) {
    reasons.push(
      `Capped at ${NO_CORROBORATION_CAP}: nothing observed required another party to act. ` +
        "Account age and activity counts are self-generated and cannot raise a score on their own.",
    );
  }

  const corroborated = allSignals
    .filter((s) => s.kind === "corroborated" && s.normalised > 0)
    .sort((a, b) => b.normalised * b.weight - a.normalised * a.weight);

  for (const s of corroborated.slice(0, 3)) {
    reasons.push(`${s.label}: ${s.value} — third parties had to act for this to exist.`);
  }

  const oldest = allSignals
    .filter((s) => s.id.endsWith("account_age_years"))
    .sort((a, b) => Number(b.value) - Number(a.value))[0];
  if (oldest) {
    reasons.push(`Oldest proven account: ${oldest.value} years on ${oldest.platform}.`);
  }

  if (consistency.provenPlatforms > 1) {
    reasons.push(
      `${consistency.provenPlatforms} platforms with proven control; name agreement ${(consistency.nameAgreement * 100).toFixed(0)}%.`,
    );
  } else {
    reasons.push("Only one platform proven — a single profile is the cheapest thing to fake.");
  }

  if (consistency.ageSpreadYears > 5) {
    reasons.push(
      `Account ages differ by ${consistency.ageSpreadYears.toFixed(1)} years — one profile is much newer than the others.`,
    );
  }

  if (corroborated.length === 0) {
    reasons.push("No corroborated signals found: everything observed could have been self-created.");
  }

  return { score, band: bandFor(score), reports, reasons, gaps, computedAt };
}
