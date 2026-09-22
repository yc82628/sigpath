/**
 * lib/challenge/verify-local.ts — the same check, run locally via Ollama.
 *
 * WHY THIS EXISTS
 * The hosted backend costs about a cent per check, which is nothing in
 * production and an obstacle during a hackathon with no credit on the account.
 * This runs the identical check against a local vision model: free, offline, and
 * with no per-call budget to think about while iterating.
 *
 * THE PROMPT IS SHARED, NOT COPIED.
 * `SYSTEM`, `VerdictSchema` and `VERIFY_THRESHOLD` are imported from verify.ts.
 * Two backends with two copies of a security-relevant prompt will drift, and the
 * one you are not currently testing will be the one that has silently lost its
 * injection defences.
 *
 * WHAT TO EXPECT FROM A LOCAL MODEL
 * Slower (seconds, not sub-second) and less reliable at fine-grained reads —
 * distinguishing handwriting from print, or catching a single wrong character in
 * a code, is exactly the kind of task where a smaller model degrades first. So:
 *
 *   - Use it to develop and to demo.
 *   - Re-run the three test photos against the hosted backend before claiming
 *     the check works, because THAT is the one whose behaviour you would ship.
 *   - If the local model passes a wrong code or a screen photo, that is evidence
 *     about the model, not proof the prompt is broken. Check both.
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

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3.5:27b";

export async function verifyChallengePhotoLocal(
  imageBase64: string,
  _mediaType: AcceptedMediaType,
  challenge: Pick<Challenge, "expected" | "kind">,
  fetchImpl: typeof fetch = fetch,
): Promise<ChallengeVerification> {
  const host = process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  const model = process.env.OLLAMA_VISION_MODEL ?? DEFAULT_MODEL;

  try {
    const res = await fetchImpl(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        // Ollama constrains decoding to this. Shared with the other backends so
        // the three cannot drift apart — see VERDICT_JSON_SCHEMA in verify.ts.
        format: VERDICT_JSON_SCHEMA,
        // Deterministic: this is a judgement that should not vary run to run.
        options: { temperature: 0 },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `Required element: ${challenge.expected}\nChallenge kind: ${challenge.kind}\n\nDescribe what you see, then judge whether the required element is present.`,
            // Ollama wants raw base64, no data-URL prefix — same as the hosted API.
            images: [imageBase64],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        passed: false,
        confidence: 0,
        observed: "",
        failureReason: "",
        unavailable: `Ollama returned ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as { message?: { content?: string } };
    const raw = data.message?.content;
    if (!raw) {
      return {
        passed: false,
        confidence: 0,
        observed: "",
        failureReason: "",
        unavailable: "Ollama returned an empty response.",
      };
    }

    let verdict: Verdict;
    try {
      verdict = JSON.parse(raw) as Verdict;
    } catch {
      // Constrained decoding should prevent this, but a truncated generation can
      // still produce invalid JSON. That is an outage, not a failed photo.
      return {
        passed: false,
        confidence: 0,
        observed: "",
        failureReason: "",
        unavailable: `Ollama returned unparseable JSON: ${raw.slice(0, 200)}`,
      };
    }

    const confidence = Math.max(0, Math.min(1, Number(verdict.confidence) || 0));
    // Same policy function as the hosted backend. The model reports; code decides.
    const { passed, reason } = decide(verdict, challenge.kind, challenge.expected);

    return {
      passed: passed && confidence >= VERIFY_THRESHOLD,
      confidence,
      observed: verdict.observed ?? "",
      failureReason:
        passed && confidence < VERIFY_THRESHOLD
          ? "Observations matched but legibility was too low to accept."
          : reason,
    };
  } catch (err) {
    // Server down, model not pulled, connection refused. Never "they failed".
    return {
      passed: false,
      confidence: 0,
      observed: "",
      failureReason: "",
      unavailable:
        err instanceof Error
          ? `${err.message} — is Ollama running? Try: ollama serve`
          : "Local verification unavailable.",
    };
  }
}
