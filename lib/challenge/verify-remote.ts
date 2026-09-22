/**
 * lib/challenge/verify-remote.ts — the same check, run against any hosted
 * OpenAI-compatible vision endpoint.
 *
 * WHY THIS EXISTS
 * There were two backends and both had a precondition a stranger cannot be
 * assumed to meet:
 *
 *   anthropic  needs an Anthropic key with credit on it.
 *   ollama     needs a GPU on the machine running the app. A 7B vision model in
 *              8GB VRAM is already tight; on a box with no discrete card it
 *              either refuses to load or takes a minute per check.
 *
 * So on a plain cloud host — a container, a $5 VPS, a judge's laptop — the
 * capture check simply could not run. This is the third option: point it at a
 * URL. The model runs on somebody else's hardware and this process only does
 * HTTP.
 *
 * WHY "OPENAI-COMPATIBLE" RATHER THAN A SPECIFIC PROVIDER
 * `POST /v1/chat/completions` is the one shape nearly every inference host
 * speaks. Writing to the shape instead of to a vendor means the same file works
 * with OpenRouter, Groq, Together, DeepInfra, Fireworks, a self-hosted vLLM, or
 * Ollama's own /v1 endpoint on a remote machine — and swapping provider is an
 * env change, not a code change. It also means no new dependency: the vendor
 * SDKs all wrap this one call.
 *
 * THE PROMPT AND THE POLICY ARE SHARED, NOT COPIED.
 * `SYSTEM`, `VERDICT_JSON_SCHEMA`, `VERIFY_THRESHOLD` and `decide` are imported
 * from verify.ts. Three backends with three copies of a security-relevant prompt
 * will drift, and the one nobody is currently testing is the one that will have
 * quietly lost its injection defences. Switching backend changes which model
 * answers; it must never change the rules, or who applies them.
 *
 * WHAT TO EXPECT
 * Model quality here is whatever you point it at, and it matters: telling
 * handwriting from print, or catching one wrong character in a code, is exactly
 * where a small model degrades first. Re-run the test photos after changing
 * VISION_MODEL. A backend that is cheap and wrong is worse than no check.
 */

import {
  SYSTEM,
  VERDICT_JSON_SCHEMA,
  VERIFY_THRESHOLD,
  decide,
  type Verdict,
  type ChallengeVerification,
  type AcceptedMediaType,
} from "./verify";
import type { Challenge } from "./generate";

/**
 * Just the bag of strings this module reads. Deliberately looser than
 * NodeJS.ProcessEnv, which requires NODE_ENV and so cannot be satisfied by a
 * small literal — a test should be able to pass three variables and nothing else.
 */
export type VisionEnv = Record<string, string | undefined>;

export interface RemoteVisionConfig {
  /** Base URL up to and including /v1 — e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** OpenRouter reads these for attribution. Ignored everywhere else. */
  referer?: string;
  title?: string;
  timeoutMs: number;
}

/**
 * Read config, or say precisely what is missing.
 *
 * A misconfigured backend must surface as "unavailable" with a message an
 * operator can act on, never as a failed capture. The user did nothing wrong
 * when the server has no API key.
 */
export function remoteVisionConfig(
  env: VisionEnv = process.env,
): { ok: true; cfg: RemoteVisionConfig } | { ok: false; reason: string } {
  const baseUrl = (env.VISION_API_BASE ?? "").trim().replace(/\/+$/, "");
  const apiKey = (env.VISION_API_KEY ?? "").trim();
  const model = (env.VISION_MODEL ?? "").trim();

  const missing = [
    !baseUrl && "VISION_API_BASE",
    !apiKey && "VISION_API_KEY",
    !model && "VISION_MODEL",
  ].filter(Boolean);

  if (missing.length) {
    return {
      ok: false,
      reason: `Remote vision backend is not configured: ${missing.join(", ")} not set. See .env.local.example.`,
    };
  }

  return {
    ok: true,
    cfg: {
      baseUrl,
      apiKey,
      model,
      referer: env.VISION_API_REFERER?.trim() || undefined,
      title: env.VISION_API_TITLE?.trim() || undefined,
      timeoutMs: Number(env.VISION_TIMEOUT_MS ?? 60_000),
    },
  };
}

/**
 * Pull the verdict object out of whatever the model wrapped it in.
 *
 * Constrained decoding should make this a no-op, but providers vary in how much
 * of the OpenAI spec they actually implement, and a reasoning model emits a
 * think block ahead of its answer. Anything this cannot parse becomes
 * "unavailable" — failing to read the response is never a failed capture.
 */
export function extractJson(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (s.startsWith("{")) return s;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  return first !== -1 && last > first ? s.slice(first, last + 1) : s;
}

function unavailable(reason: string): ChallengeVerification {
  return { passed: false, confidence: 0, observed: "", failureReason: "", unavailable: reason };
}

/** The strict JSON-schema form. Preferred: the provider constrains decoding. */
function strictFormat() {
  return {
    type: "json_schema" as const,
    json_schema: {
      name: "capture_verdict",
      strict: true,
      schema: { ...VERDICT_JSON_SCHEMA, additionalProperties: false },
    },
  };
}

export async function verifyChallengePhotoRemote(
  imageBase64: string,
  mediaType: AcceptedMediaType,
  challenge: Pick<Challenge, "expected" | "kind">,
  fetchImpl: typeof fetch = fetch,
  env: VisionEnv = process.env,
): Promise<ChallengeVerification> {
  const conf = remoteVisionConfig(env);
  if (!conf.ok) return unavailable(conf.reason);
  const cfg = conf.cfg;

  // Unlike Ollama's /api/chat, the OpenAI shape carries an image as a data URL —
  // so the media type validated at the boundary has to travel with it.
  const dataUrl = `data:${mediaType};base64,${imageBase64}`;

  const userText =
    `Required element: ${challenge.expected}\n` +
    `Challenge kind: ${challenge.kind}\n\n` +
    `Describe what you see, then judge whether the required element is present.`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.apiKey}`,
  };
  if (cfg.referer) headers["HTTP-Referer"] = cfg.referer;
  if (cfg.title) headers["X-Title"] = cfg.title;

  const post = async (jsonObjectMode: boolean) => {
    // json_object mode carries no schema, so the field list has to be in the
    // prompt — and the word JSON must appear or OpenAI-spec servers reject it.
    const text = jsonObjectMode
      ? `${userText}\n\nReply with JSON only, containing exactly these keys: ${Object.keys(
          VERDICT_JSON_SCHEMA.properties,
        ).join(", ")}.`
      : userText;

    return fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(cfg.timeoutMs),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        // Deterministic: this is a judgement that should not vary run to run.
        temperature: 0,
        response_format: jsonObjectMode ? { type: "json_object" } : strictFormat(),
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
  };

  try {
    let res = await post(false);

    // Not every host implements json_schema. When one rejects the format, drop
    // to plain JSON mode rather than reporting the capture uncheckable — but
    // only for that specific complaint, so a real 400 still surfaces.
    if (!res.ok && (res.status === 400 || res.status === 422)) {
      const body = await res.text();
      if (/response_format|json_schema|schema/i.test(body)) {
        res = await post(true);
      } else {
        return unavailable(`Vision API returned ${res.status}: ${body.slice(0, 200)}`);
      }
    }

    if (!res.ok) {
      const body = await res.text();
      // 401/403 is a key problem, 402 is no credit, 429 is rate limiting. Every
      // one of them is our problem, not the user's — hence unavailable.
      return unavailable(`Vision API returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
      error?: { message?: string };
    };

    // Some gateways answer 200 with an error body.
    if (data.error?.message) {
      return unavailable(`Vision API error: ${data.error.message.slice(0, 200)}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return unavailable("Vision API returned an empty response.");
    }

    let verdict: Verdict;
    try {
      verdict = JSON.parse(extractJson(content)) as Verdict;
    } catch {
      return unavailable(`Vision API returned unparseable JSON: ${content.slice(0, 200)}`);
    }

    // A model that answered in the wrong shape has not judged anything. Do not
    // let a missing boolean coerce to false and read as a clean observation:
    // `shown_on_electronic_display: undefined` would sail straight past decide()
    // and a photo of a screen would pass because the response was malformed.
    for (const key of [
      "shown_on_electronic_display",
      "written_by_hand_on_physical_surface",
      "required_element_present",
    ] as const) {
      if (typeof verdict?.[key] !== "boolean") {
        return unavailable(`Vision API omitted "${key}" — the verdict cannot be trusted.`);
      }
    }

    const confidence = Math.max(0, Math.min(1, Number(verdict.confidence) || 0));
    // Same policy function as every other backend. The model reports; code decides.
    const { passed, reason } = decide(verdict, challenge.kind, challenge.expected);

    return {
      passed: passed && confidence >= VERIFY_THRESHOLD,
      confidence,
      observed: verdict.observed ?? "",
      kind: challenge.kind,
      fingersVisible: verdict.fingers_visible,
      failureReason:
        passed && confidence < VERIFY_THRESHOLD
          ? "Observations matched but legibility was too low to accept."
          : reason,
    };
  } catch (err) {
    // DNS, TLS, timeout, connection refused. Never "they failed".
    const msg = err instanceof Error ? err.message : "Remote verification unavailable.";
    return unavailable(
      /timeout|abort/i.test(msg)
        ? `Vision API did not respond within ${cfg.timeoutMs}ms.`
        : `${msg} — check VISION_API_BASE and VISION_API_KEY.`,
    );
  }
}
