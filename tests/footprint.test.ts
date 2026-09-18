import { test } from "node:test";
import assert from "node:assert";
import { computeFootprintScore, checkConsistency } from "../lib/footprint/score";
import type { PlatformReport, Signal } from "../lib/footprint/types";

function sig(over: Partial<Signal> = {}): Signal {
  return {
    id: "github.merged_prs_external",
    platform: "github",
    kind: "corroborated",
    label: "Merged PRs in others' repositories",
    value: 30,
    normalised: 0.8,
    weight: 2.0,
    ...over,
  };
}

function report(over: Partial<PlatformReport> = {}): PlatformReport {
  return {
    platform: "github",
    status: "ok",
    handle: "yuchuan",
    ownershipProven: true,
    signals: [sig()],
    collectedAt: Date.now(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Rule 1: "we could not check" must never be scored as "they failed".
// This is the one that matters most in production — getting it wrong means
// telling a legitimate business it looks fraudulent because GitHub throttled us.
// ---------------------------------------------------------------------------

test("a rate-limited platform does not reduce the score", () => {
  const withoutX = computeFootprintScore([report()]);
  const withRateLimitedX = computeFootprintScore([
    report(),
    report({ platform: "x", status: "rate_limited", ownershipProven: false, signals: [], detail: "429" }),
  ]);

  assert.equal(
    withRateLimitedX.score,
    withoutX.score,
    "an unreachable platform must be neutral, not negative",
  );
});

test("an unreachable platform is surfaced as a gap, not hidden", () => {
  const s = computeFootprintScore([
    report(),
    report({ platform: "x", status: "rate_limited", ownershipProven: false, signals: [], detail: "429" }),
  ]);
  assert.ok(
    s.gaps.some((g) => g.includes("x") && g.includes("did not reduce the score")),
    `expected an explicit gap for x, got: ${JSON.stringify(s.gaps)}`,
  );
});

// ---------------------------------------------------------------------------
// Rule 2: signals from an unproven account are worth nothing.
// Anyone can type "torvalds" into a form.
// ---------------------------------------------------------------------------

test("unproven ownership contributes no signal value", () => {
  const proven = computeFootprintScore([report()]);
  const unproven = computeFootprintScore([
    report({ ownershipProven: false, status: "ownership_unproven", signals: [] }),
  ]);

  assert.equal(unproven.score, 0);
  assert.equal(unproven.band, "insufficient");
  assert.ok(proven.score > unproven.score);
});

test("no proven platforms yields an explicit refusal to judge", () => {
  const s = computeFootprintScore([
    report({ ownershipProven: false, status: "not_linked", signals: [] }),
  ]);
  assert.equal(s.score, 0);
  assert.match(s.reasons[0], /no claim can be made/i);
});

// ---------------------------------------------------------------------------
// Breadth and corroboration
// ---------------------------------------------------------------------------

test("three agreeing platforms beat one deep platform", () => {
  const one = computeFootprintScore([report()]);
  const three = computeFootprintScore([
    report(),
    report({ platform: "linkedin", signals: [sig({ platform: "linkedin" })] }),
    report({ platform: "x", signals: [sig({ platform: "x" })] }),
  ]);
  assert.ok(
    three.score > one.score,
    `breadth should raise the score: one=${one.score} three=${three.score}`,
  );
});

test("a lone platform is called out as cheap to fake", () => {
  const s = computeFootprintScore([report()]);
  assert.ok(s.reasons.some((r) => /cheapest thing to fake/i.test(r)));
});

test("self-asserted-only evidence is flagged as uncorroborated", () => {
  const s = computeFootprintScore([
    report({
      signals: [sig({ id: "github.public_repos", kind: "self_asserted", weight: 0.3, normalised: 0.9 })],
    }),
  ]);
  assert.ok(
    s.reasons.some((r) => /could have been self-created/i.test(r)),
    `expected an uncorroborated warning, got: ${JSON.stringify(s.reasons)}`,
  );
});

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

test("mismatched handles lower name agreement", () => {
  const agreeing = checkConsistency([
    report({ handle: "yuchuan" }),
    report({ platform: "x", handle: "yuchuan" }),
  ]);
  const mismatched = checkConsistency([
    report({ handle: "yuchuan" }),
    report({ platform: "x", handle: "zzzqqq999" }),
  ]);
  assert.ok(
    agreeing.nameAgreement > mismatched.nameAgreement,
    `agreeing=${agreeing.nameAgreement} mismatched=${mismatched.nameAgreement}`,
  );
});

test("a much newer account shows up as age spread", () => {
  const c = checkConsistency([
    report({ signals: [sig({ id: "github.account_age_years", value: 9, kind: "temporal" })] }),
    report({
      platform: "x",
      signals: [sig({ id: "x.account_age_years", platform: "x", value: 0.2, kind: "temporal" })],
    }),
  ]);
  assert.ok(c.ageSpreadYears > 5, `expected a wide spread, got ${c.ageSpreadYears}`);
});
