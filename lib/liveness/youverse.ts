// lib/liveness/youverse.ts
import type { LivenessProvider, LivenessResult, LivenessSession } from "./types";

export class YouVerseLivenessProvider implements LivenessProvider {
  readonly name = "youverse";
  constructor(private apiKey: string) {}

  async createSession(userRef: string): Promise<LivenessSession> {
    const res = await fetch("https://api.youverse.id/liveness/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userRef }),
    });
    if (!res.ok) throw new Error("YouVerse session creation failed");
    const data = await res.json();
    return { sessionId: data.id, clientToken: data.clientToken };
  }

  async getResult(sessionId: string, clientPayload?: unknown): Promise<LivenessResult> {
    const res = await fetch(`https://api.youverse.id/liveness/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error("YouVerse result fetch failed");
    const data = await res.json();
    return {
      passed: data.live === true,
      score: data.score || 0,
      provider: this.name,
    };
  }
}