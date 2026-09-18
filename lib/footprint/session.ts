/**
 * lib/footprint/session.ts
 *
 * Server-side record of which platforms a user has PROVEN they control.
 *
 * THIS IS THE TRUST BOUNDARY — same role as lib/liveness/store.ts.
 * The browser is never allowed to assert "I own this GitHub account". The route
 * verifies the proof, records the outcome here, and later reads it back when
 * building the score. A client that POSTs {ownershipProven: true} gets nowhere,
 * because the route never reads ownership from the request body.
 *
 * In-memory Map: does not survive a restart, and is per-instance. Fine for a
 * single dev server or a demo. Back it with Redis or a DB before running more
 * than one instance, or a proof recorded by one process will be invisible to
 * the next request.
 */

import { randomUUID } from "crypto";
import type { Platform } from "./types";
import type { LinkedinIdentity } from "./linkedin";
import type { OwnershipChallenge } from "./ownership";

interface ProvenAccount {
  handle: string;
  proofUrl?: string;
  provenAt: number;
}

interface Session {
  createdAt: number;
  /** Outstanding ownership challenges, keyed by platform. */
  challenges: Partial<Record<Platform, OwnershipChallenge>>;
  /** Platforms this session has proven. */
  proven: Partial<Record<Platform, ProvenAccount>>;
  linkedin?: LinkedinIdentity;
}

const SESSIONS = new Map<string, Session>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, s] of SESSIONS) {
    if (s.createdAt < cutoff) SESSIONS.delete(id);
  }
}

export function createSession(): string {
  sweep();
  const id = randomUUID();
  SESSIONS.set(id, { createdAt: Date.now(), challenges: {}, proven: {} });
  return id;
}

export function getSession(id: string): Session | undefined {
  sweep();
  return SESSIONS.get(id);
}

export function putChallenge(id: string, c: OwnershipChallenge): boolean {
  const s = SESSIONS.get(id);
  if (!s) return false;
  s.challenges[c.platform] = c;
  return true;
}

export function takeChallenge(id: string, platform: Platform): OwnershipChallenge | undefined {
  return SESSIONS.get(id)?.challenges[platform];
}

export function recordProven(
  id: string,
  platform: Platform,
  account: Omit<ProvenAccount, "provenAt">,
): boolean {
  const s = SESSIONS.get(id);
  if (!s) return false;
  s.proven[platform] = { ...account, provenAt: Date.now() };
  // A challenge is single-use: once proven, the nonce cannot be replayed.
  delete s.challenges[platform];
  return true;
}

export function recordLinkedin(id: string, identity: LinkedinIdentity): boolean {
  const s = SESSIONS.get(id);
  if (!s) return false;
  s.linkedin = identity;
  s.proven.linkedin = { handle: identity.name ?? identity.sub, provenAt: Date.now() };
  return true;
}

export function sessionSummary(id: string) {
  const s = SESSIONS.get(id);
  if (!s) return null;
  return {
    proven: Object.fromEntries(
      Object.entries(s.proven).map(([k, v]) => [k, { handle: v.handle, provenAt: v.provenAt }]),
    ),
    pending: Object.keys(s.challenges),
  };
}

export function getProven(id: string) {
  const s = SESSIONS.get(id);
  if (!s) return null;
  return { proven: s.proven, linkedin: s.linkedin };
}
