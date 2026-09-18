import { test } from "node:test";
import assert from "node:assert";
import type Anthropic from "@anthropic-ai/sdk";
import { verifyChallengePhoto, VERIFY_THRESHOLD, isAcceptedMediaType } from "../lib/challenge/verify";
import { VisionLivenessProvider } from "../lib/liveness/vision";

/** Minimal stand-in for the SDK client so these tests cost nothing to run. */
function stubClient(parsed: unknown, stopReason = "end_turn"): Anthropic {
  return {
    messages: {
      parse: async () => ({ parsed_output: parsed, stop_reason: stopReason }),
    },
  } as unknown as Anthropic;
}

function throwingClient(message: string): Anthropic {
  return {
    messages: {
      parse: async () => {
        throw new Error(message);
      },
    },
  } as unknown as Anthropic;
}

const CHALLENGE = { expected: "handwritten code 7K4M", kind: "code" as const };
const IMG = "aGVsbG8="; // contents irrelevant — the client is stubbed

// ---------------------------------------------------------------------------
// The distinction the whole design rests on: failing a check vs. not running it
// ---------------------------------------------------------------------------

test("a network failure reports unavailable, not failure", async () => {
  const r = await verifyChallengePhoto(IMG, "image/jpeg", CHALLENGE, throwingClient("ECONNRESET"));
  assert.equal(r.passed, false);
  assert.ok(r.unavailable, "must set unavailable so the caller can tell the difference");
  assert.equal(r.failureReason, "", "must not blame the user for our outage");
});

test("a model refusal reports unavailable, not failure", async () => {
  const r = await verifyChallengePhoto(IMG, "image/jpeg", CHALLENGE, stubClient(null, "refusal"));
  assert.equal(r.passed, false);
  assert.ok(r.unavailable);
  assert.equal(r.failureReason, "");
});

test("a genuine mismatch is a failure, not unavailable", async () => {
  const r = await verifyChallengePhoto(
    IMG,
    "image/jpeg",
    CHALLENGE,
    stubClient({ observed: "a hand holding blank paper", shown_on_electronic_display: false, written_by_hand_on_physical_surface: false, required_element_present: false, confidence: 0.95, failure_reason: "no code visible" }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.unavailable, undefined);
  assert.match(r.failureReason, /no code visible/);
});

// ---------------------------------------------------------------------------
// Confidence gating
// ---------------------------------------------------------------------------

test("a match below the confidence threshold does not pass", async () => {
  const r = await verifyChallengePhoto(
    IMG,
    "image/jpeg",
    CHALLENGE,
    stubClient({ observed: "blurry 7K4M", shown_on_electronic_display: false, written_by_hand_on_physical_surface: true, required_element_present: true, confidence: VERIFY_THRESHOLD - 0.1, failure_reason: "" }),
  );
  assert.equal(r.passed, false);
  assert.match(r.failureReason, /legibility/i);
});

test("a confident match passes", async () => {
  const r = await verifyChallengePhoto(
    IMG,
    "image/jpeg",
    CHALLENGE,
    stubClient({ observed: "handwritten 7K4M on paper beside a face", shown_on_electronic_display: false, written_by_hand_on_physical_surface: true, required_element_present: true, confidence: 0.96, failure_reason: "" }),
  );
  assert.equal(r.passed, true);
  assert.equal(r.confidence, 0.96);
});

test("confidence is clamped to 0..1", async () => {
  const r = await verifyChallengePhoto(
    IMG,
    "image/jpeg",
    CHALLENGE,
    stubClient({ observed: "x", shown_on_electronic_display: false, written_by_hand_on_physical_surface: true, required_element_present: true, confidence: 4.2, failure_reason: "" }),
  );
  assert.equal(r.confidence, 1);
});

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

test("only real image media types are accepted", () => {
  assert.ok(isAcceptedMediaType("image/jpeg"));
  assert.ok(isAcceptedMediaType("image/png"));
  assert.ok(!isAcceptedMediaType("image/svg+xml"), "SVG can carry script — must be rejected");
  assert.ok(!isAcceptedMediaType("text/html"));
});

// ---------------------------------------------------------------------------
// Session behaviour
// ---------------------------------------------------------------------------

test("an unknown session is unavailable, not a failure", async () => {
  const p = new VisionLivenessProvider("person");
  const r = await p.verify("no-such-session", { imageBase64: IMG, mediaType: "image/jpeg" });
  assert.equal(r.passed, false);
  assert.ok(r.unavailable);
});

test("a missing image is unavailable, not a failure", async () => {
  const p = new VisionLivenessProvider("person");
  const s = await p.createSession("user-1");
  const r = await p.verify(s.sessionId, undefined);
  assert.ok(r.unavailable);
  assert.equal(r.failureReason, "");
});

test("an unsupported media type is a failure with a reason", async () => {
  const p = new VisionLivenessProvider("person");
  const s = await p.createSession("user-1");
  const r = await p.verify(s.sessionId, { imageBase64: IMG, mediaType: "text/html" });
  assert.equal(r.passed, false);
  assert.equal(r.unavailable, undefined);
  assert.match(r.failureReason, /Unsupported image type/);
});

test("createSession issues an instruction the user can act on", async () => {
  const p = new VisionLivenessProvider("person");
  const s = await p.createSession("user-1");
  assert.ok(s.clientToken && s.clientToken.length > 10);
  assert.ok(/fingers|paper/i.test(s.clientToken), `unexpected instruction: ${s.clientToken}`);
});

test("the public challenge never leaks the expected answer", async () => {
  const { getPublicChallenge } = await import("../lib/liveness/vision");
  const p = new VisionLivenessProvider("person");
  const s = await p.createSession("user-1");
  const pub = getPublicChallenge(s.sessionId);
  assert.ok(pub, "challenge should exist");
  assert.ok(!("expected" in (pub as object)), "expected is the reviewer checklist — never send it to the client");
});
