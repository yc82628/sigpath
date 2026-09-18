import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CHALLENGE_TTL_SECONDS, CHALLENGE_GRACE_SECONDS } from "../lib/challenge/generate";

/**
 * Invariants behind the "camera only, 90 seconds" claim.
 *
 * These are structural tests, not behavioural ones. They exist because both
 * properties are easy to break by accident — someone adds a file input "just for
 * testing", or bumps the window to make a demo less fiddly — and neither change
 * fails any other test. The claim would quietly become false while everything
 * stayed green.
 */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Strip comments so a file that *documents* the rule does not trip it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|\*).*$/gm, "");
}

test("no file input exists anywhere in the app", () => {
  // The whole point of camera-only is that there is no second path from disk to
  // the verifier. A hidden or disabled input is still a path — an attacker edits
  // the DOM, they do not click your buttons.
  const offenders: string[] = [];
  for (const file of sourceFiles("app")) {
    const code = stripComments(readFileSync(file, "utf8"));
    if (/type\s*=\s*["'{]?\s*file/.test(code)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `file input found — camera-only no longer holds: ${offenders.join(", ")}`,
  );
});

test("capture reads from getUserMedia, not from a picker", () => {
  const src = readFileSync("app/components/CameraCapture.tsx", "utf8");
  assert.ok(src.includes("getUserMedia"), "capture must come from a live stream");
  assert.ok(src.includes("drawImage"), "frame must be drawn from the video element");
});

test("the challenge window stays at 90 seconds", () => {
  // Raising this is the intuitive move and it is backwards. Generation takes
  // seconds, so a longer window does not deny an attacker time to *generate* —
  // it hands them time to COMPOSITE: write the code, photograph it, blend it
  // with a swapped face, check the result, retry. An honest user with pen and
  // paper needs 30-45 seconds.
  //
  // If you change this, change it DOWN, and only after measuring false
  // rejections on real devices.
  assert.equal(CHALLENGE_TTL_SECONDS, 90);
  assert.ok(CHALLENGE_TTL_SECONDS <= 120, "never exceed 120s");
  assert.ok(CHALLENGE_TTL_SECONDS >= 60, "below 60s starts failing real people");
});

test("the grace period cannot swallow the window", () => {
  // Clock skew and upload latency need slack, but a grace period that is a large
  // fraction of the window silently extends it.
  assert.ok(
    CHALLENGE_GRACE_SECONDS <= CHALLENGE_TTL_SECONDS * 0.2,
    `grace ${CHALLENGE_GRACE_SECONDS}s is too large a share of a ${CHALLENGE_TTL_SECONDS}s window`,
  );
});

test("the liveness route never reads a pass from the request body", () => {
  // The browser must not be able to assert its own result. If this route ever
  // reads `passed` off the body, a client can POST {passed:true} and mint a
  // LIVE_CAPTURE flag without taking a photo at all.
  const src = stripComments(readFileSync("app/api/liveness/route.ts", "utf8"));
  assert.ok(!/body\.passed/.test(src), "route must not trust a client-asserted pass");
  assert.ok(src.includes("recordLiveness"), "outcome must be recorded server-side");
});
