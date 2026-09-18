/**
 * spend.ts — rate limiting and a spend ceiling for the fee-payer wallet.
 *
 * THE HOLE THIS CLOSES
 * /api/register signs with a server-held keypair, so the fee-payer is a shared,
 * drainable resource. Each seal locks ~0.0024 SOL of rent. A loop posting random
 * 32-byte hashes against a valid session empties the wallet, and on mainnet that
 * is real money rather than a faucet refill. There is currently no limit of any
 * kind on that route.
 *
 * In-memory, same as lib/liveness/store.ts, so it carries the same caveat: it
 * does not survive a restart and it is per-instance. Fine for a demo run
 * locally; move to Redis before hosting anywhere multi-instance, or the limits
 * silently multiply by your instance count.
 */

const SOL_PER_SEAL = 0.0024; // rent for one Fingerprint PDA
const SAFETY_MARGIN = 1.15; // headroom for tx fees and rent-exemption drift

export interface SpendPolicy {
  /** Registrations allowed per session id. Onboarding is a one-shot flow. */
  perSession: number;
  /** Registrations per IP per window. */
  perIp: number;
  /** Rolling window for the IP limit, in ms. */
  windowMs: number;
  /** Hard ceiling on SOL this process will spend before refusing everything. */
  dailySolCap: number;
}

export const DEFAULT_POLICY: SpendPolicy = {
  perSession: 2, // one capture, one retry
  perIp: 20,
  windowMs: 60 * 60 * 1000,
  dailySolCap: 0.25, // ~100 seals
};

interface Bucket {
  count: number;
  resetAt: number;
}

const sessionUse = new Map<string, number>();
const ipBuckets = new Map<string, Bucket>();

let spentSol = 0;
let spendResetAt = Date.now() + 24 * 60 * 60 * 1000;

export type DenyReason = "session_exhausted" | "ip_rate_limited" | "daily_cap_reached";

export interface SpendDecision {
  allowed: boolean;
  reason?: DenyReason;
  /** Operator-facing. Do NOT leak the specific reason to the client. */
  detail?: string;
  retryAfterSeconds?: number;
}

/**
 * Call at the TOP of /api/register, before any signing or RPC work.
 * Returns a decision; on allow, call `recordSpend()` only once the transaction
 * actually confirms, so failed sends do not consume budget.
 */
export function checkSpend(
  sessionId: string,
  ip: string,
  policy: SpendPolicy = DEFAULT_POLICY,
): SpendDecision {
  const now = Date.now();

  if (now > spendResetAt) {
    spentSol = 0;
    spendResetAt = now + 24 * 60 * 60 * 1000;
  }

  if (spentSol + SOL_PER_SEAL * SAFETY_MARGIN > policy.dailySolCap) {
    return {
      allowed: false,
      reason: "daily_cap_reached",
      detail: `Daily fee-payer cap of ${policy.dailySolCap} SOL reached. Spent ${spentSol.toFixed(4)}.`,
      retryAfterSeconds: Math.ceil((spendResetAt - now) / 1000),
    };
  }

  const used = sessionUse.get(sessionId) ?? 0;
  if (used >= policy.perSession) {
    return {
      allowed: false,
      reason: "session_exhausted",
      detail: `Session ${sessionId} already used ${used} registrations.`,
    };
  }

  const bucket = ipBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    ipBuckets.set(ip, { count: 1, resetAt: now + policy.windowMs });
  } else if (bucket.count >= policy.perIp) {
    return {
      allowed: false,
      reason: "ip_rate_limited",
      detail: `IP ${ip} exceeded ${policy.perIp} registrations in the window.`,
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    };
  } else {
    bucket.count += 1;
  }

  sessionUse.set(sessionId, used + 1);
  return { allowed: true };
}

/** Call only after the transaction confirms. */
export function recordSpend(solSpent: number = SOL_PER_SEAL): void {
  spentSol += solSpent;
}

/** Refund the session/IP budget when a send fails, so users are not punished for our errors. */
export function releaseSpend(sessionId: string): void {
  const used = sessionUse.get(sessionId) ?? 0;
  if (used > 0) sessionUse.set(sessionId, used - 1);
}

export function spendStatus(policy: SpendPolicy = DEFAULT_POLICY) {
  return {
    spentSol: Number(spentSol.toFixed(6)),
    capSol: policy.dailySolCap,
    remainingSeals: Math.max(0, Math.floor((policy.dailySolCap - spentSol) / SOL_PER_SEAL)),
    resetsAt: new Date(spendResetAt).toISOString(),
  };
}

/**
 * Client-facing error. Deliberately uniform across all three deny reasons —
 * telling a caller WHICH limit they hit lets them tune around it.
 */
export const GENERIC_DENIAL = {
  ok: false,
  error: "Verification temporarily unavailable. Please try again shortly.",
} as const;
