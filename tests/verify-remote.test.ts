import { test } from "node:test";
import assert from "node:assert";
import {
  verifyChallengePhotoRemote,
  remoteVisionConfig,
  extractJson,
} from "../lib/challenge/verify-remote";
import { VERIFY_THRESHOLD, VERDICT_JSON_SCHEMA, VerdictSchema } from "../lib/challenge/verify";

/**
 * The remote backend exists so the capture check can run on a machine with no
 * GPU and no Anthropic credit. That makes it the backend most likely to be the
 * one actually running at a demo — so it has to hold the same two lines as the
 * others:
 *
 *   1. A photo of a screen never passes.
 *   2. "We could not check" is never reported as "you failed".
 *
 * Every test here stubs fetch, so none of them cost money or need a network.
 */

const CHALLENGE = { expected: "handwritten code 7K4M", kind: "code" as const };
const IMG = "aGVsbG8="; // contents irrelevant — fetch is stubbed

const ENV = {
  VISION_API_BASE: "https://example.test/v1",
  VISION_API_KEY: "test-key",
  VISION_MODEL: "test-vl",
};

function verdict(over: Record<string, unknown> = {}) {
  return {
    observed: "a handwritten code on paper",
    shown_on_electronic_display: false,
    written_by_hand_on_physical_surface: true,
    required_element_present: true,
    confidence: 0.95,
    failure_reason: "",
    ...over,
  };
}

/** Stub that answers 200 with `content` as the assistant message. */
function replying(content: string, capture?: { body?: unknown; url?: string }) {
  return (async (url: string, init: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.body = JSON.parse(init.body as string);
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function erroring(status: number, body: string, onCall?: (n: number) => void) {
  let n = 0;
  return (async () => {
    onCall?.(++n);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// The rule the whole check exists for
// ---------------------------------------------------------------------------

test("a photo of a screen is rejected on the remote backend too", async () => {
  // decide() is shared, but this proves the remote path actually calls it
  // rather than trusting whatever the provider returned.
  const r = await verifyChallengePhotoRemote(
    IMG,
    "image/jpeg",
    CHALLENGE,
    replying(JSON.stringify(verdict({ shown_on_electronic_display: true, confidence: 1 }))),
    ENV,
  );
  assert.equal(r.passed, false);
  assert.match(r.failureReason, /electronic display|screen/i);
});

test("a clean handwritten capture passes", async () => {
  const r = await verifyChallengePhotoRemote(
    IMG,
    "image/jpeg",
    CHALLENGE,
    replying(JSON.stringify(verdict())),
    ENV,
  );
  assert.equal(r.passed, true);
  assert.ok(r.confidence >= VERIFY_THRESHOLD);
});

test("a malformed verdict is unavailable, not a pass", async () => {
  // THE DANGEROUS CASE. A provider that ignores the schema and omits
  // shown_on_electronic_display would give decide() `undefined`, which is
  // falsy — so a photo of a screen would pass because the response was broken.
  const { shown_on_electronic_display, ...missing } = verdict();
  void shown_on_electronic_display;

  const r = await verifyChallengePhotoRemote(
    IMG,
    "image/jpeg",
    CHALLENGE,
    replying(JSON.stringify(missing)),
    ENV,
  );
  assert.equal(r.passed, false);
  assert.ok(r.unavailable, "a missing observation must be an outage, not a verdict");
  assert.match(r.unavailable!, /shown_on_electronic_display/);
});

// ---------------------------------------------------------------------------
// Failing the check vs. not running it
// ---------------------------------------------------------------------------

test("missing configuration names the variable and reports unavailable", async () => {
  const r = await verifyChallengePhotoRemote(IMG, "image/jpeg", CHALLENGE, replying("{}"), {
    VISION_API_BASE: "https://example.test/v1",
  });
  assert.equal(r.passed, false);
  assert.match(r.unavailable ?? "", /VISION_API_KEY/);
  assert.match(r.unavailable ?? "", /VISION_MODEL/);
});

test("401, 402 and 429 are unavailable — never a failed capture", async () => {
  for (const status of [401, 402, 429, 500]) {
    const r = await verifyChallengePhotoRemote(
      IMG,
      "image/jpeg",
      CHALLENGE,
      erroring(status, "nope"),
      ENV,
    );
    assert.equal(r.passed, false);
    assert.ok(r.unavailable, `${status} must report unavailable`);
    assert.equal(r.failureReason, "", `${status} must not blame the user`);
  }
});

test("a gateway that answers 200 with an error body is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: "insufficient credits" } }), {
      status: 200,
    })) as unknown as typeof fetch;

  const r = await verifyChallengePhotoRemote(IMG, "image/jpeg", CHALLENGE, fetchImpl, ENV);
  assert.ok(r.unavailable);
  assert.match(r.unavailable!, /insufficient credits/);
});

test("a connection failure is unavailable, not failure", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const r = await verifyChallengePhotoRemote(IMG, "image/jpeg", CHALLENGE, fetchImpl, ENV);
  assert.equal(r.passed, false);
  assert.match(r.unavailable ?? "", /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// Provider compatibility — the reason this file is generic
// ---------------------------------------------------------------------------

test("a host that rejects json_schema is retried in plain JSON mode", async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(init.body as string);
    if (body.response_format.type === "json_schema") {
      return new Response("response_format.json_schema is not supported", { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict()) } }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const r = await verifyChallengePhotoRemote(IMG, "image/jpeg", CHALLENGE, fetchImpl, ENV);
  assert.equal(calls, 2, "should have retried once");
  assert.equal(r.passed, true);
});

test("a 400 that is not about the response format is not retried", async () => {
  // Retrying a genuine bad request just doubles the latency before the same
  // failure, and hides the real message.
  let calls = 0;
  const r = await verifyChallengePhotoRemote(
    IMG,
    "image/jpeg",
    CHALLENGE,
    erroring(400, "image too large", (n) => (calls = n)),
    ENV,
  );
  assert.equal(calls, 1);
  assert.match(r.unavailable ?? "", /image too large/);
});

test("fenced and reasoning-wrapped JSON is still read", () => {
  const obj = '{"a":1}';
  assert.equal(extractJson(obj), obj);
  assert.equal(extractJson("```json\n" + obj + "\n```"), obj);
  assert.equal(extractJson("<think>hmm, a screen?</think>\n" + obj), obj);
  assert.equal(extractJson("Here is the verdict: " + obj + " — done"), obj);
});

test("the image is sent as a data URL carrying its media type", async () => {
  // The OpenAI shape has no separate media-type field, so a wrong prefix here
  // means the provider misreads the bytes — and PNG captures silently fail.
  const seen: { body?: unknown; url?: string } = {};
  await verifyChallengePhotoRemote(
    IMG,
    "image/png",
    CHALLENGE,
    replying(JSON.stringify(verdict()), seen),
    ENV,
  );

  const body = seen.body as { messages: { content: unknown }[] };
  const parts = body.messages[1].content as { type: string; image_url?: { url: string } }[];
  const image = parts.find((p) => p.type === "image_url");
  assert.equal(image?.image_url?.url, `data:image/png;base64,${IMG}`);
  assert.equal(seen.url, "https://example.test/v1/chat/completions");
});

test("the expected code never leaves as a system-prompt leak to the client", async () => {
  // `expected` has to reach the model, but it must travel in the request only —
  // it is the answer key, and it is never part of what comes back.
  const r = await verifyChallengePhotoRemote(
    IMG,
    "image/jpeg",
    CHALLENGE,
    replying(JSON.stringify(verdict())),
    ENV,
  );
  assert.ok(!JSON.stringify(r).includes("7K4M"));
});

// ---------------------------------------------------------------------------
// The shared schema
// ---------------------------------------------------------------------------

test("the JSON schema and the zod schema describe the same verdict", () => {
  // Three backends read VERDICT_JSON_SCHEMA and one reads VerdictSchema. If a
  // field is added to one and not the other, the backends stop asking the same
  // question — and the field most likely to be dropped is the screen check.
  const zodKeys = Object.keys(VerdictSchema.shape).sort();
  assert.deepEqual(Object.keys(VERDICT_JSON_SCHEMA.properties).sort(), zodKeys);
  assert.deepEqual([...VERDICT_JSON_SCHEMA.required].sort(), zodKeys);
});

test("a trailing slash on the base URL does not double up", () => {
  const conf = remoteVisionConfig({ ...ENV, VISION_API_BASE: "https://example.test/v1/" });
  assert.ok(conf.ok);
  assert.equal(conf.ok && conf.cfg.baseUrl, "https://example.test/v1");
});
