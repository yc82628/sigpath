/**
 * lib/guard/limit.ts — rate limits that hold across every Vercel instance.
 *
 * WHY
 * The limits used to be counters in each instance's memory. On Vercel a
 * request may land on any of several short-lived instances, so a limit of 20
 * was really 20 per instance, reset whenever one was recycled. And the routes
 * that spend the most had none: every search uses the eBay Browse quota (5,000
 * calls a day for the whole site), /api/attest pays rent from the operator
 * wallet, /api/liveness and Ai-chan call a model.
 *
 * HOW
 * A fixed window per rule and client, counted in the shared database
 * (lib/kv/upstash.ts): INCR on `sigpath:rl:<rule>:<client>:<window>`, which
 * expires on its own after the window. Two commands per limited request, one
 * round trip. Without a database, or if it doesn't answer, the old in-memory
 * counter takes over: the site degrades to per-instance limits, never to
 * refusing everyone or to no limits at all.
 *
 * WHAT IS STORED
 * Not the IP address: an HMAC of it, keyed by a server secret, so the database
 * never holds an address and the value can't be reversed by trying every IP
 * without the secret. Each counter is deleted by the database when its window
 * ends (at most a day, for the daily caps). The privacy page says so.
 */

import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { UpstashKv, type Kv } from "../kv/upstash";
import { RateLimiter } from "../assistant/rate-limit";

export interface Rule {
  /** Names the counter: [a-z-]+. */
  name: string;
  limit: number;
  windowSecs: number;
  /** One counter for everyone: a site-wide cap rather than a per-client limit. */
  global?: boolean;
  /** Shown to the client when the limit is reached. */
  message: string;
}

const TEN_MIN = 10 * 60;
const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * Every limit, in one place. Generous for a person, tight for a script: a
 * shopper doesn't run 60 searches in ten minutes; a loop does in seconds.
 */
export const RULES = {
  /** Each search is an eBay Browse call against a daily quota for the whole site. */
  search: { name: "search", limit: 60, windowSecs: TEN_MIN, message: "That's a lot of searches. Give it a few minutes and try again." },
  /** Every turn is a model call. */
  assistant: { name: "assistant", limit: 20, windowSecs: TEN_MIN, message: "That's a lot of questions! Give it a few minutes and try again." },
  /** A camera frame judged by the vision model. */
  liveness: { name: "liveness", limit: 20, windowSecs: HOUR, message: "Too many photo checks. Try again in an hour." },
  /** Each new handle costs the operator wallet rent for an on-chain record. */
  attest: { name: "attest", limit: 5, windowSecs: HOUR, message: "Too many verifications. Try again in an hour." },
  attestDaily: { name: "attest-daily", limit: 50, windowSecs: DAY, global: true, message: "Verification is paused for today. Try again tomorrow." },
  vat: { name: "vat", limit: 10, windowSecs: TEN_MIN, message: "Too many checks. Try again in a few minutes." },
  domain: { name: "domain", limit: 20, windowSecs: TEN_MIN, message: "Too many checks. Try again in a few minutes." },
  supplier: { name: "supplier", limit: 10, windowSecs: TEN_MIN, message: "Too many checks. Try again in a few minutes." },
  /** Routes that write a record, sign something or send a transaction. */
  write: { name: "write", limit: 30, windowSecs: TEN_MIN, message: "Too many requests. Try again in a few minutes." },
  /** The cart asking for its prices again: each request, and each eBay item in it (the daily quota). */
  cart: { name: "cart", limit: 30, windowSecs: TEN_MIN, message: "Too many cart refreshes. Try again in a few minutes." },
  cartItem: { name: "cart-item", limit: 150, windowSecs: TEN_MIN, message: "Too many price checks. Try again in a few minutes." },
  /** Price alerts: the browser asks for its inbox now and then; still not a loop. */
  alerts: { name: "alerts", limit: 60, windowSecs: TEN_MIN, message: "Too many requests. Try again in a few minutes." },
  /** The browser extension: each check is an eBay search; each "seen" report a database write. */
  extension: { name: "extension", limit: 60, windowSecs: TEN_MIN, message: "Too many checks. Try again in a few minutes." },
  extensionSeen: { name: "extension-seen", limit: 60, windowSecs: TEN_MIN, message: "Too many requests. Try again in a few minutes." },
} satisfies Record<string, Rule>;

type Env = Record<string, string | undefined>;
type HeaderSource = { get(name: string): string | null };

/** The client's address as Vercel reports it. "local" when there's none (dev, tests). */
export function clientIp(headers: HeaderSource): string {
  return headers.get("x-real-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
}

/** The client as the counters know it: an HMAC of the address, never the address. */
export function clientId(ip: string, env: Env = process.env): string {
  const secret = env.RATE_LIMIT_SECRET?.trim() || env.QUOTE_SECRET?.trim() || env.KV_REST_API_TOKEN?.trim() || "sigpath-rate-limit";
  return createHmac("sha256", secret).update(`rate-limit:${ip}`).digest("base64url").slice(0, 22);
}

export interface Verdict {
  ok: boolean;
  /** Seconds until the window resets, for Retry-After. */
  retryAfter: number;
}

/** In-memory fallback counters, per rule, for when there's no database. */
const memory = new Map<string, RateLimiter>();

function memoryAllow(rule: Rule, client: string, nowMs: number): Verdict {
  let m = memory.get(rule.name);
  if (!m) memory.set(rule.name, (m = new RateLimiter(rule.limit, rule.windowSecs * 1000)));
  return { ok: m.allow(client, nowMs), retryAfter: rule.windowSecs };
}

/**
 * Count one request against a rule and say whether it's allowed.
 * `kv` is the shared database, or null for memory only.
 */
export async function hit(rule: Rule, client: string, kv: Kv | null, nowMs = Date.now()): Promise<Verdict> {
  if (!/^[a-z-]+$/.test(rule.name)) throw new Error("Invalid rule name.");
  const who = rule.global ? "all" : client;
  const window = Math.floor(nowMs / 1000 / rule.windowSecs);
  const retryAfter = Math.max(1, (window + 1) * rule.windowSecs - Math.floor(nowMs / 1000));
  if (!kv) return memoryAllow(rule, who, nowMs);
  const key = `sigpath:rl:${rule.name}:${who}:${window}`;
  try {
    const [count] = await kv.pipeline([
      ["INCR", key],
      // A little past the window, so a slow request can't find it already gone.
      ["EXPIRE", key, rule.windowSecs + 60],
    ]);
    return { ok: Number(count) <= rule.limit, retryAfter };
  } catch {
    // The database didn't answer: per-instance limits rather than none.
    return memoryAllow(rule, who, nowMs);
  }
}

/**
 * For a route: null when allowed, else the 429 to return. Every rule given is
 * counted (e.g. a per-client limit and a site-wide daily cap).
 */
export async function limited(
  headers: HeaderSource,
  rules: Rule | Rule[],
  env: Env = process.env,
  kv: Kv | null = UpstashKv.fromEnv(env),
): Promise<NextResponse | null> {
  const client = clientId(clientIp(headers), env);
  for (const rule of Array.isArray(rules) ? rules : [rules]) {
    const v = await hit(rule, client, kv);
    if (!v.ok) {
      return NextResponse.json({ error: rule.message }, { status: 429, headers: { "Retry-After": String(v.retryAfter), "Cache-Control": "no-store" } });
    }
  }
  return null;
}

/** For a page: the message to show when the limit is reached, else null. */
export async function limitedMessage(
  headers: HeaderSource,
  rule: Rule,
  env: Env = process.env,
  kv: Kv | null = UpstashKv.fromEnv(env),
): Promise<string | null> {
  return (await hit(rule, clientId(clientIp(headers), env), kv)).ok ? null : rule.message;
}
