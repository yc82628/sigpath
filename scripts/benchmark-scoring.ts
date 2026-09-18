/**
 * scripts/benchmark-scoring.ts — does the score actually discriminate?
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 *
 * It measures DISCRIMINATION: do accounts with genuinely different histories get
 * meaningfully different scores? That is testable with public data, today.
 *
 * It does NOT measure ACCURACY. Accuracy means "how often does this correctly
 * flag a fraudulent account", and answering it requires a labelled set of known
 * fakes. We have none. Any number reported here as "accuracy" would be invented.
 *
 * Read the output as: the model separates these cohorts / the model does not.
 * If cohorts overlap, the weighting is wrong regardless of how good the top
 * scores look.
 *
 * Ownership is forced to `true` here so the scoring is what is under test, not
 * the proof flow. In production an unproven account scores 0 by construction.
 *
 * Run:  npx tsx scripts/benchmark-scoring.ts
 * With a token (recommended — 60 req/hr unauthenticated will rate-limit):
 *   GITHUB_TOKEN=ghp_... npx tsx scripts/benchmark-scoring.ts
 */

interface Cohort {
  name: string;
  /** What we expect, stated BEFORE seeing results so this is a test, not a story. */
  expectation: string;
  handles: string[];
}

/**
 * Cohorts chosen so the boundaries are meaningful:
 *  - deep contributors have the signal we weight hardest (merged PRs elsewhere)
 *  - famous-but-not-collaborative isolates popularity from corroboration
 *  - org/bot accounts have activity but no human collaboration pattern
 *  - thin accounts are the closest public proxy we have for a fresh fake
 */
const COHORTS: Cohort[] = [
  {
    name: "deep contributors",
    expectation: "high — years of merged PRs in others' repos",
    handles: ["sindresorhus", "yyx990803", "kentcdodds"],
  },
  {
    name: "popular, low collaboration",
    expectation: "lower than above despite huge follower counts",
    handles: ["octocat", "torvalds", "a"],
  },
  {
    name: "bot / automation accounts",
    expectation: "low — activity without human corroboration",
    handles: ["dependabot", "github-actions"],
  },
  {
    name: "thin accounts",
    expectation: "near zero — the closest public proxy for a fresh fake",
    handles: ["test", "zzzz"],
  },
];

async function main() {
  const { collectGithub } = await import("../lib/footprint/github");
  const { computeFootprintScore } = await import("../lib/footprint/score");

  if (!process.env.GITHUB_TOKEN) {
    console.log("! GITHUB_TOKEN unset — 60 req/hr limit. Expect rate_limited rows.\n");
  }

  const rows: Array<{ cohort: string; handle: string; score: number; band: string; note: string }> = [];

  for (const cohort of COHORTS) {
    for (const handle of cohort.handles) {
      // The search API allows ~10 req/min unauthenticated. Without a pause the
      // run rate-limits partway through and the results are silently partial.
      if (!process.env.GITHUB_TOKEN) await new Promise((r) => setTimeout(r, 7000));
      const report = await collectGithub(handle, true);

      if (report.status !== "ok") {
        rows.push({
          cohort: cohort.name,
          handle,
          score: -1,
          band: report.status,
          note: report.detail ?? "",
        });
        continue;
      }

      const scored = computeFootprintScore([report]);
      const prs = report.signals.find((s) => s.id === "github.merged_prs_external")?.value ?? "?";
      const followers = report.signals.find((s) => s.id === "github.followers")?.value ?? "?";
      const age = report.signals.find((s) => s.id === "github.account_age_years")?.value ?? "?";

      rows.push({
        cohort: cohort.name,
        handle,
        score: scored.score,
        band: scored.band,
        note: `PRs=${prs} followers=${followers} age=${age}y`,
      });
    }
  }

  // --- report ---------------------------------------------------------------
  console.log("=".repeat(78));
  console.log("SCORE DISCRIMINATION — single platform (GitHub), ownership forced true");
  console.log("=".repeat(78));

  for (const cohort of COHORTS) {
    console.log(`\n${cohort.name.toUpperCase()}`);
    console.log(`  expected: ${cohort.expectation}`);
    for (const r of rows.filter((x) => x.cohort === cohort.name)) {
      const score = r.score < 0 ? r.band.padEnd(8) : String(r.score).padStart(3) + "     ";
      console.log(`    ${r.handle.padEnd(16)} ${score} ${r.note}`);
    }
  }

  // --- cohort separation ----------------------------------------------------
  console.log("\n" + "=".repeat(78));
  console.log("COHORT MEANS");
  console.log("=".repeat(78));

  const means: Array<[string, number, number]> = [];
  for (const cohort of COHORTS) {
    const valid = rows.filter((x) => x.cohort === cohort.name && x.score >= 0);
    if (valid.length === 0) {
      console.log(`  ${cohort.name.padEnd(28)} no data`);
      continue;
    }
    const mean = valid.reduce((s, x) => s + x.score, 0) / valid.length;
    means.push([cohort.name, mean, valid.length]);
    console.log(`  ${cohort.name.padEnd(28)} ${mean.toFixed(1).padStart(5)}  (n=${valid.length})`);
  }

  if (means.length >= 2) {
    const top = means[0][1];
    const bottom = means[means.length - 1][1];
    const gap = top - bottom;
    console.log(`\n  separation, top cohort to bottom: ${gap.toFixed(1)} points`);
    console.log(
      gap >= 30
        ? "  -> the model separates these cohorts."
        : "  -> WEAK separation. The weighting is not doing enough work.",
    );
  }

  console.log("\nNOTE: this is discrimination, not accuracy. Measuring accuracy needs");
  console.log("labelled fraudulent accounts, which this benchmark does not have.");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
