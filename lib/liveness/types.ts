// Liveness verification abstraction.
//
// The whole point of this file is the SEAM: everything else talks to this
// interface, so swapping the mock for a real provider (YouVerse / FaceTec /
// Amazon Rekognition Face Liveness) is a single new file + an env var, with no
// changes to the capture flow, the API routes, or the on-chain program.
//
// Real providers all follow the same shape used here: the server creates a
// session and hands the client a short-lived token, the client SDK runs the
// challenge (blink / turn / move to light), then the server fetches the result.

export interface LivenessResult {
  passed: boolean;
  score: number; // 0..1 confidence
  provider: string;
  // An opaque identifier for the face that passed (embedding / template).
  // We never store this raw — only its hash goes on-chain, binding the photo to
  // "the face that passed liveness" without holding recoverable biometric data.
  faceTemplate?: string;
}

export interface LivenessSession {
  sessionId: string;
  clientToken?: string; // token the client SDK needs to run the challenge
}

export interface LivenessProvider {
  readonly name: string;

  // Called server-side to start a verification.
  createSession(userRef: string): Promise<LivenessSession>;

  // Called server-side after the client finishes the challenge.
  // `clientPayload` is whatever the client SDK returns (opaque here).
  getResult(sessionId: string, clientPayload?: unknown): Promise<LivenessResult>;
}

// Minimum confidence to accept. Tune per provider; keep it strict.
export const LIVENESS_THRESHOLD = 0.9;
