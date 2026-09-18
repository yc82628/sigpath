import { randomBytes, createHash } from "crypto";

// Server-side record of liveness outcomes. This is the trust boundary: the
// client is never allowed to assert "I passed liveness". /api/liveness records
// the verified result here, and /api/register looks it up by sessionId before it
// will set the on-chain liveness flag. A forged sessionId won't be found.
//
// It also issues the CAPTURE NONCE — a random, single-use, short-lived challenge
// the client must bind into its signature. That's what proves the capture
// happened after the challenge was issued rather than being a replayed photo.
//
// In-memory Map is fine for a single-process dev server and the hackathon demo.
// For production/serverless (multiple instances), back this with Redis or a DB.

type Entry = {
  passed: boolean;
  score: number;
  createdAt: number;
  consumed: boolean;
  nonce: Uint8Array; // 32-byte challenge
  faceHashHex: string; // hash of the liveness face template ("" if none)
};

const STORE = new Map<string, Entry>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes — a challenge must be used promptly

// Issued when the session is created, before any capture happens.
export function issueNonce(sessionId: string): Uint8Array {
  const nonce = new Uint8Array(randomBytes(32));
  STORE.set(sessionId, {
    passed: false,
    score: 0,
    createdAt: Date.now(),
    consumed: false,
    nonce,
    faceHashHex: "",
  });
  return nonce;
}

// Records the verified outcome. `faceTemplate` is whatever the liveness provider
// returns to identify the face (an embedding / template). We store only its HASH
// — never the biometric itself — so the on-chain record binds the photo to "the
// face that passed liveness" without us holding recoverable biometric data.
export function recordLiveness(
  sessionId: string,
  passed: boolean,
  score: number,
  faceTemplate?: string
): void {
  const e = STORE.get(sessionId);
  if (!e) return;
  e.passed = passed;
  e.score = score;
  if (faceTemplate) {
    e.faceHashHex = createHash("sha256").update(faceTemplate).digest("hex");
  }
}

export function peekNonce(sessionId: string): Uint8Array | null {
  const e = STORE.get(sessionId);
  return e ? e.nonce : null;
}

export type ConsumedSession = { nonce: Uint8Array; faceHashHex: string };

// Returns the session data only if it exists, passed, hasn't expired, and hasn't
// already been used. Marks it consumed so a nonce can never be replayed.
export function consumeLiveness(sessionId: string): ConsumedSession | null {
  const e = STORE.get(sessionId);
  if (!e) return null;
  if (e.consumed) return null;
  if (Date.now() - e.createdAt > TTL_MS) {
    STORE.delete(sessionId);
    return null;
  }
  if (!e.passed) return null;
  e.consumed = true;
  return { nonce: e.nonce, faceHashHex: e.faceHashHex };
}
