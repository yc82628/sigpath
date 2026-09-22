import { test } from "node:test";
import assert from "node:assert";
import { verifyChallengePhotoLocal } from "../lib/challenge/verify-local";
import { VERDICT_JSON_SCHEMA, VERIFY_THRESHOLD } from "../lib/challenge/verify";

/**
 * The Ollama backend had no tests at all, which is backwards: it is the one
 * being demoed with, so it is the one whose behaviour matters on the day.
 *
 * Everything here stubs fetch — no model, no GPU, no network.
 */

const IMG = "aGVsbG8=";
const CODE = { expected: "handwritten code 7K4M", kind: "code" as const };
const BOTH = { expected: "handwritten code A3F4 and 3 fingers visible", kind: "code_fingers" as const };

function verdict(over: Record<string, unknown> = {}) {
  return {
    observed: "a handwritten code on paper",
    shown_on_electronic_display: false,
    written_by_hand_on_physical_surface: true,
    required_element_present: true,
    fingers_visible: -1,
    confidence: 0.95,
    failure_reason: "",
    ...over,
  };
}

function replying(v: Record<string, unknown>, capture?: { body?: any }) {
  return (async (_url: string, init: RequestInit) => {
    if (capture) capture.body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ message: { content: JSON.stringify(v) } }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// keep_alive: the difference between a demo that works and one that times out
// ---------------------------------------------------------------------------

test("every request asks Ollama to keep the model resident", async () => {
  // Ollama unloads an idle model after ~5 minutes, and a cold load is ~48s
  // against a 90-second challenge window. A demo is precisely a lull followed
  // by one important capture, so without this the capture that matters is the
  // one that expires.
  const seen: { body?: any } = {};
  await verifyChallengePhotoLocal(IMG, "image/jpeg", CODE, replying(verdict(), seen));
  assert.equal(seen.body.keep_alive, "30m");
});

test("OLLAMA_KEEP_ALIVE overrides the default", async () => {
  const prev = process.env.OLLAMA_KEEP_ALIVE;
  process.env.OLLAMA_KEEP_ALIVE = "-1";
  try {
    const seen: { body?: any } = {};
    await verifyChallengePhotoLocal(IMG, "image/jpeg", CODE, replying(verdict(), seen));
    assert.equal(seen.body.keep_alive, "-1");
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_KEEP_ALIVE;
    else process.env.OLLAMA_KEEP_ALIVE = prev;
  }
});

test("decoding is constrained to the shared schema", async () => {
  // Not a local copy. A backend asking for a different set of fields is how
  // the screen check gets quietly dropped from one path.
  const seen: { body?: any } = {};
  await verifyChallengePhotoLocal(IMG, "image/jpeg", CODE, replying(verdict(), seen));
  assert.deepEqual(seen.body.format, JSON.parse(JSON.stringify(VERDICT_JSON_SCHEMA)));
  assert.equal(seen.body.options.temperature, 0, "a judgement must not vary run to run");
});

// ---------------------------------------------------------------------------
// The policy is shared, so it must hold here too
// ---------------------------------------------------------------------------

test("a photo of a screen is rejected", async () => {
  const r = await verifyChallengePhotoLocal(
    IMG,
    "image/jpeg",
    CODE,
    replying(verdict({ shown_on_electronic_display: true, confidence: 1 })),
  );
  assert.equal(r.passed, false);
  assert.match(r.failureReason, /display|screen/i);
});

test("a clean handwritten capture passes", async () => {
  const r = await verifyChallengePhotoLocal(IMG, "image/jpeg", CODE, replying(verdict()));
  assert.equal(r.passed, true);
});

test("the combined challenge needs both halves", async () => {
  const right = await verifyChallengePhotoLocal(
    IMG,
    "image/jpeg",
    BOTH,
    replying(verdict({ fingers_visible: 3 })),
  );
  assert.equal(right.passed, true);

  // Right code, wrong gesture. The count reaches decide() through this backend
  // too — `expected` has to be passed through, and it would be easy not to.
  const wrong = await verifyChallengePhotoLocal(
    IMG,
    "image/jpeg",
    BOTH,
    replying(verdict({ fingers_visible: 4 })),
  );
  assert.equal(wrong.passed, false);
  assert.match(wrong.failureReason, /counted 4/i);
});

test("a low-confidence match is rejected as illegible, not as cheating", async () => {
  const r = await verifyChallengePhotoLocal(
    IMG,
    "image/jpeg",
    CODE,
    replying(verdict({ confidence: VERIFY_THRESHOLD - 0.1 })),
  );
  assert.equal(r.passed, false);
  assert.match(r.failureReason, /legibility/i);
});

// ---------------------------------------------------------------------------
// Failing the check vs. not running it
// ---------------------------------------------------------------------------

test("Ollama being down is unavailable, and says how to fix it", async () => {
  const fetchImpl = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  }) as unknown as typeof fetch;

  const r = await verifyChallengePhotoLocal(IMG, "image/jpeg", CODE, fetchImpl);
  assert.equal(r.passed, false);
  assert.equal(r.failureReason, "", "an outage must not blame the user");
  assert.match(r.unavailable ?? "", /ollama serve/i);
});

test("an HTTP error is unavailable, not a failed capture", async () => {
  const fetchImpl = (async () =>
    new Response("model not found", { status: 404 })) as unknown as typeof fetch;

  const r = await verifyChallengePhotoLocal(IMG, "image/jpeg", CODE, fetchImpl);
  assert.ok(r.unavailable);
  assert.match(r.unavailable!, /404/);
});

test("a truncated response is unavailable, not a failed capture", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ message: { content: '{"observed": "tru' } }), {
      status: 200,
    })) as unknown as typeof fetch;

  const r = await verifyChallengePhotoLocal(IMG, "image/jpeg", CODE, fetchImpl);
  assert.equal(r.passed, false);
  assert.match(r.unavailable ?? "", /unparseable/i);
});
