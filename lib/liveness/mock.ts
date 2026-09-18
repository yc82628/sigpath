import { randomUUID } from "crypto";
import type { LivenessProvider, LivenessResult, LivenessSession } from "./types";

// Mock provider for the hackathon demo. It mimics the real request/response
// shape but always passes with a high score. Replace by adding a sibling file
// (e.g. youverse.ts) that implements LivenessProvider against the real API and
// wiring it up in ./index.ts — nothing else changes.
//
// DEMO HONESTY: this does not actually detect anything. In the pitch, say the
// liveness layer is stubbed and point to this seam as the integration path.
export class MockLivenessProvider implements LivenessProvider {
  readonly name = "mock";

  async createSession(_userRef: string): Promise<LivenessSession> {
    return { sessionId: randomUUID(), clientToken: "mock-token" };
  }

  async getResult(_sessionId: string, _clientPayload?: unknown): Promise<LivenessResult> {
    // Simulate provider latency so the UI flow feels real.
    await new Promise((r) => setTimeout(r, 400));
    // A real provider returns a face template here; the mock emits a stable
    // placeholder so the face-binding path is exercised end to end.
    return {
      passed: true,
      score: 0.99,
      provider: this.name,
      faceTemplate: "mock-face-template",
    };
  }
}
