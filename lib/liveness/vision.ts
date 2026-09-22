/**
 * lib/liveness/vision.ts
 *
 * A LivenessProvider backed by challenge verification rather than a biometric
 * SDK. Slots into the existing seam: set LIVENESS_PROVIDER=vision and nothing
 * else in the capture flow, the API routes, or the on-chain program changes.
 *
 * HOW IT DIFFERS FROM A BIOMETRIC PROVIDER
 * FaceTec and friends answer "is this a live human face?" from a face template.
 * This answers "did whoever took this photo satisfy an unpredictable instruction
 * inside 90 seconds?" — a different question with a different failure mode, and
 * one that does not require collecting biometrics at all.
 *
 * NO FACE TEMPLATE, DELIBERATELY
 * `faceTemplate` is left undefined. There is no embedding to hash, so the
 * on-chain `face_hash` stays zeroed — which register_fingerprint already
 * supports ("zeroed if none"). Do not invent a placeholder here: a hash that
 * looks like a biometric binding but binds nothing is worse than an honest zero,
 * because a verifier downstream will believe it. It is also a privacy win worth
 * saying out loud in the pitch — this design never holds face data.
 */

import { randomUUID } from "crypto";
import type { LivenessProvider, LivenessResult, LivenessSession } from "./types";
import { buildChallenge, checkDeadline, publicChallenge, type Challenge } from "../challenge/generate";
import {
  verifyChallengePhoto,
  isAcceptedMediaType,
  type ChallengeVerification,
} from "../challenge/verify";
import { verifyChallengePhotoLocal } from "../challenge/verify-local";
import { verifyChallengePhotoRemote } from "../challenge/verify-remote";

/**
 * Which backend judges the photo.
 *
 *   VISION_BACKEND=anthropic  (default) hosted Claude. Needs ANTHROPIC_API_KEY
 *                             with credit. The strongest of the three.
 *   VISION_BACKEND=remote     any OpenAI-compatible vision endpoint — OpenRouter,
 *                             Groq, Together, vLLM, a remote Ollama. Needs no
 *                             local GPU, which is what makes the app deployable
 *                             to an ordinary cloud host.
 *   VISION_BACKEND=ollama     local, free, needs a GPU on this machine.
 *
 * The prompt, the JSON schema and decide() are shared across all three, so
 * switching backends changes which model answers — never the rules, and never
 * who applies them.
 */
function backend() {
  switch ((process.env.VISION_BACKEND ?? "anthropic").toLowerCase()) {
    case "ollama":
      return verifyChallengePhotoLocal;
    // "openai" and "openrouter" are the names people reach for first; they all
    // mean the same OpenAI-compatible path.
    case "remote":
    case "openai":
    case "openrouter":
      return verifyChallengePhotoRemote;
    default:
      return verifyChallengePhoto;
  }
}

/**
 * sessionId -> the challenge that session must satisfy.
 *
 * In-memory, same caveat as lib/liveness/store.ts: it does not survive a restart
 * and it is per-instance. Fine for a demo; move to Redis before running more
 * than one instance, or a capture will be verified against a challenge the
 * other process never issued.
 */
const CHALLENGES = new Map<string, Challenge>();

/** What the client is allowed to see — `expected` is stripped. */
export function getPublicChallenge(sessionId: string) {
  const c = CHALLENGES.get(sessionId);
  return c ? publicChallenge(c) : null;
}

/** Payload the capture UI sends back. */
export interface VisionClientPayload {
  /** Raw base64, no data-URL prefix. */
  imageBase64: string;
  mediaType: string;
}

function isVisionPayload(p: unknown): p is VisionClientPayload {
  if (typeof p !== "object" || p === null) return false;
  const q = p as Record<string, unknown>;
  return typeof q.imageBase64 === "string" && typeof q.mediaType === "string";
}

export class VisionLivenessProvider implements LivenessProvider {
  readonly name = "vision";

  constructor(private subject: "item" | "person" = "person") {}

  async createSession(_userRef: string): Promise<LivenessSession> {
    const sessionId = randomUUID();
    const challenge = buildChallenge(this.subject);
    CHALLENGES.set(sessionId, challenge);
    // The instruction is not a secret — the user has to read it. The deadline
    // is enforced server-side in getResult regardless of what the client does
    // with the countdown.
    return { sessionId, clientToken: challenge.instruction };
  }

  /**
   * Interface-compatible result. Use `verify()` when you need to distinguish
   * "failed the check" from "the check could not run" — this method collapses
   * both to passed:false because LivenessResult has nowhere to put the
   * difference, and an API route must not seal a registration on either.
   */
  async getResult(sessionId: string, clientPayload?: unknown): Promise<LivenessResult> {
    const v = await this.verify(sessionId, clientPayload);
    return {
      passed: v.passed,
      score: v.confidence,
      provider: this.name,
      // faceTemplate intentionally omitted — see file header.
    };
  }

  /** The richer result. Prefer this in API routes. */
  async verify(sessionId: string, clientPayload?: unknown): Promise<ChallengeVerification> {
    const challenge = CHALLENGES.get(sessionId);
    if (!challenge) {
      return {
        passed: false,
        confidence: 0,
        observed: "",
        failureReason: "",
        unavailable: "Unknown or expired session.",
      };
    }

    // Enforce the deadline HERE, server-side. The UI countdown is a courtesy.
    const deadline = checkDeadline(challenge);
    if (!deadline.ok) {
      CHALLENGES.delete(sessionId);
      return {
        passed: false,
        confidence: 0,
        observed: "",
        failureReason: `Capture window expired (${Math.round(deadline.overdueMs / 1000)}s late).`,
      };
    }

    if (!isVisionPayload(clientPayload)) {
      return {
        passed: false,
        confidence: 0,
        observed: "",
        failureReason: "",
        unavailable: "No image supplied.",
      };
    }
    if (!isAcceptedMediaType(clientPayload.mediaType)) {
      return {
        passed: false,
        confidence: 0,
        observed: "",
        failureReason: `Unsupported image type: ${clientPayload.mediaType}`,
      };
    }

    const result = await backend()(
      clientPayload.imageBase64,
      clientPayload.mediaType,
      challenge,
    );

    // Single-use: a challenge that has been judged cannot be retried with a
    // second photo. Otherwise an attacker brute-forces the same nonce until one
    // render is convincing enough. Only burn it when the check actually ran —
    // a network failure should not cost the user their attempt.
    if (!result.unavailable) CHALLENGES.delete(sessionId);

    return result;
  }
}
