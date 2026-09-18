import type { LivenessProvider } from "./types";
import { MockLivenessProvider } from "./mock";
import { VisionLivenessProvider } from "./vision";

// Choose the provider from env. Default to mock for local/hackathon.
//   LIVENESS_PROVIDER=mock        (default) — always passes, detects nothing
//   LIVENESS_PROVIDER=vision      challenge verification via Claude vision;
//                                 needs ANTHROPIC_API_KEY
//   LIVENESS_PROVIDER=youverse    (implement ./youverse.ts, see stub below)
let cached: LivenessProvider | null = null;

export function getLivenessProvider(): LivenessProvider {
  if (cached) return cached;
  const which = (process.env.LIVENESS_PROVIDER || "mock").toLowerCase();
  switch (which) {
    case "vision":
      cached = new VisionLivenessProvider("person");
      break;
    // case "youverse":
    //   cached = new YouVerseLivenessProvider(process.env.YOUVERSE_API_KEY!);
    //   break;
    case "mock":
    default:
      cached = new MockLivenessProvider();
  }
  return cached;
}

/*
 * DROP-IN EXAMPLE — a real provider is just this interface against their API.
 *
 * import type { LivenessProvider, LivenessResult, LivenessSession } from "./types";
 *
 * export class YouVerseLivenessProvider implements LivenessProvider {
 *   readonly name = "youverse";
 *   constructor(private apiKey: string) {}
 *
 *   async createSession(userRef: string): Promise<LivenessSession> {
 *     const res = await fetch("https://api.youverse.id/liveness/sessions", {
 *       method: "POST",
 *       headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
 *       body: JSON.stringify({ userRef }),
 *     });
 *     const data = await res.json();
 *     return { sessionId: data.id, clientToken: data.clientToken };
 *   }
 *
 *   async getResult(sessionId: string): Promise<LivenessResult> {
 *     const res = await fetch(`https://api.youverse.id/liveness/sessions/${sessionId}`, {
 *       headers: { authorization: `Bearer ${this.apiKey}` },
 *     });
 *     const data = await res.json();
 *     return { passed: data.live === true, score: data.score, provider: this.name };
 *   }
 * }
 */
