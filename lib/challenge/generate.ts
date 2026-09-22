/**
 * lib/challenge/generate.ts
 *
 * Human-readable, time-boxed capture challenges.
 *
 * WHAT THIS CHANGES
 * Your existing flow already issues a random 32-byte nonce, keeps it single-use,
 * and requires the device to sign `media_hash || nonce`. That mechanism is
 * correct and is NOT touched here. What this adds is a human-readable
 * INSTRUCTION issued alongside the nonce, plus a hard deadline.
 *
 * WHY THE INSTRUCTION MATTERS MORE THAN THE CLOCK
 * A face-swap rig runs in real time once it is set up — so a short window alone
 * does not defeat it. What defeats it is an instruction the attacker could not
 * have prepared for, inside a window too short to prepare one:
 *
 *   "Write 7K4M on paper and hold it next to the item."
 *
 * Generative tools handle faces. They do not handle an arbitrary random string
 * in the user's own handwriting, in frame, with correct lighting and
 * perspective, in 90 seconds. That is the gap this exploits, and it is a
 * defensible claim because it describes what the code actually does.
 *
 * HONEST LIMIT — say this in the pitch before a judge says it for you:
 * the instruction is verified by a HUMAN or a downstream model looking at the
 * photo. This module issues and time-boxes the challenge; it does not itself
 * confirm the fingers were held up. Do not claim otherwise.
 */

import { randomBytes, randomInt } from "crypto";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Deadline in seconds. 90s is the trade-off: long enough that an honest user
 * with the item in front of them can comply, short enough that sourcing a photo
 * elsewhere, compositing, or building a rig is not viable.
 *
 * Do not raise this above ~120 without a reason. Do not lower it below ~60 —
 * you will start failing real people with shaky hands and slow phones, and a
 * false rejection costs you a user.
 */
export const CHALLENGE_TTL_SECONDS = 90;

/** Grace period for clock skew and upload latency. */
export const CHALLENGE_GRACE_SECONDS = 10;

// ---------------------------------------------------------------------------
// Challenge vocabulary
// ---------------------------------------------------------------------------

/**
 * `fingers` is retained for decoding old sessions and is no longer generated.
 * See buildChallenge: a gesture alone has about four possible values, so a
 * blind retry passes one time in four. Live person challenges now use
 * `code_fingers`, where the code carries the entropy and the gesture proves a
 * hand moved on demand.
 */
export type ChallengeKind = "code" | "fingers" | "code_fingers" | "adjacent" | "angle";

export interface Challenge {
  /** Opaque id for this challenge, safe to log. */
  challengeId: string;
  kind: ChallengeKind;
  /** What the user is told to do. Shown verbatim in the capture UI. */
  instruction: string;
  /** The expected element, for the reviewer's checklist. Never sent to the client. */
  expected: string;
  /** Unix ms when this expires. */
  expiresAt: number;
  /** Seconds allowed, for the countdown. */
  ttlSeconds: number;
}

/** Unambiguous alphabet — no O/0, I/1, S/5, B/8. Handwriting has to be readable. */
const CODE_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY2346789";

const COLORS = ["blue", "red", "green", "yellow", "black", "white"];

function code(len = 4): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Build a challenge.
 *
 * @param subject "item" for marketplace listings, "person" for identity checks.
 *
 * For marketplace verification the `code` kind is by far the strongest, because
 * it requires physical handwriting co-located with the object. The others exist
 * for variety so a returning user does not memorise one routine.
 */
export function buildChallenge(subject: "item" | "person" = "item"): Challenge {
  const challengeId = randomBytes(8).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_SECONDS * 1000;
  const base = { challengeId, expiresAt, ttlSeconds: CHALLENGE_TTL_SECONDS };

  if (subject === "person") {
    const c = code();

    // A GESTURE ALONE IS NOT A CHALLENGE.
    // "Hold up 3 fingers" has four possible answers, so an attacker replaying a
    // prepared video of someone holding up fingers gets in one attempt in four —
    // and no amount of counting accuracy fixes that, because the check is
    // working correctly when it passes them. The code carries the entropy
    // (28^4 ≈ 614k); the gesture adds a second, simultaneous physical act that a
    // still image or a prepared clip will not happen to match.
    // So every person challenge now contains a code, and the gesture rides
    // along. Never issue the gesture on its own.
    const kinds: ChallengeKind[] = ["code_fingers", "code"];
    const kind = kinds[randomInt(kinds.length)];

    if (kind === "code_fingers") {
      const n = randomInt(2, 6); // 2..5 — one finger reads badly, five is the max
      return {
        ...base,
        kind: "code_fingers",
        instruction:
          `Write ${c} on a piece of paper and hold it next to your face, ` +
          `and hold up ${n} fingers with your other hand.`,
        // Order matters: expectedFingerCount() reads the trailing clause, and
        // the code sits behind "code " where a stray digit cannot be mistaken
        // for a finger count.
        expected: `handwritten code ${c} and ${n} fingers visible`,
      };
    }

    return {
      ...base,
      kind: "code",
      instruction: `Write ${c} on a piece of paper and hold it next to your face.`,
      expected: `handwritten code ${c}`,
    };
  }

  // subject === "item"
  const kinds: ChallengeKind[] = ["code", "code", "adjacent", "angle"]; // code weighted
  const kind = kinds[randomInt(kinds.length)];

  switch (kind) {
    case "adjacent": {
      const colour = COLORS[randomInt(COLORS.length)];
      return {
        ...base,
        kind: "adjacent",
        instruction: `Place the item next to something ${colour} and photograph them together.`,
        expected: `item beside a ${colour} object`,
      };
    }
    case "angle": {
      const deg = [30, 45, 60][randomInt(3)];
      const c = code(3);
      return {
        ...base,
        kind: "angle",
        instruction: `Write ${c} on paper, place it beside the item, and photograph both from about ${deg}°.`,
        expected: `handwritten code ${c}, oblique angle ~${deg}°`,
      };
    }
    default: {
      const c = code();
      return {
        ...base,
        kind: "code",
        instruction: `Write ${c} on a piece of paper and hold it next to the item.`,
        expected: `handwritten code ${c}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Deadline enforcement
// ---------------------------------------------------------------------------

export type DeadlineResult =
  | { ok: true; elapsedMs: number }
  | { ok: false; reason: "expired"; overdueMs: number };

/**
 * Enforce the deadline SERVER-SIDE. The countdown in the UI is a courtesy; it is
 * not a control, because a client can be modified. This is the control.
 *
 * Call it inside consumeLiveness (or immediately after) in /api/register.
 */
export function checkDeadline(
  challenge: Pick<Challenge, "expiresAt" | "ttlSeconds">,
  now: number = Date.now(),
): DeadlineResult {
  const hardLimit = challenge.expiresAt + CHALLENGE_GRACE_SECONDS * 1000;
  if (now > hardLimit) {
    return { ok: false, reason: "expired", overdueMs: now - hardLimit };
  }
  const issuedAt = challenge.expiresAt - challenge.ttlSeconds * 1000;
  return { ok: true, elapsedMs: now - issuedAt };
}

/**
 * What the client is allowed to see. Note `expected` is stripped — sending the
 * reviewer's checklist to the browser would let a caller confirm what to fake.
 */
export function publicChallenge(c: Challenge) {
  return {
    challengeId: c.challengeId,
    kind: c.kind,
    instruction: c.instruction,
    expiresAt: c.expiresAt,
    ttlSeconds: c.ttlSeconds,
  };
}

/**
 * Seconds left, floored at zero. Shared by the API and the countdown so both
 * agree on the number.
 */
export function secondsLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}
