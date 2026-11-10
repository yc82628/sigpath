/**
 * lib/stats/counter.ts — how much SigPath is used, counted without knowing by whom.
 *
 * WHY
 * "How many people checked a price last week?" is the first thing anyone
 * deciding about SigPath asks, and the answer has to be honest without breaking
 * the promise that nothing about a shopper is kept. So this keeps totals and
 * nothing else: one number per event per day.
 *
 * WHAT IS KEPT
 * A hash per day (Berlin time), "sigpath:stats:2026-11-07", whose fields are the
 * event names below and whose values are counts. No search words, no product,
 * no price, no address, no IP, no cookie, no id of any kind: a count can't be
 * traced back to anyone, because nothing in it ever pointed at anyone.
 * Each day's totals are kept 400 days, then dropped by the database.
 *
 * WHAT ISN'T COUNTED
 * Crawlers and link previews (by their user agent): they'd inflate the numbers
 * for nobody. Nor anything outside the live site (VERCEL_ENV=production): a
 * local run or a preview deployment uses the same database. A count that fails (database down) is skipped, never retried and
 * never in the way of the answer the shopper asked for.
 */

import type { Kv } from "../kv/upstash";
import { UpstashKv } from "../kv/upstash";

/** Every event counted, in the order the stats page lists them. Nothing outside this list is ever written. */
export const EVENTS = ["search", "check", "ext-shop", "ext-ebay", "good-deal", "caution", "inflated-discount", "click"] as const;
export type StatEvent = (typeof EVENTS)[number];

/** Each day's totals are kept this long, a little over a year so a year can be compared with the last. */
export const KEEP_DAYS = 400;

const PREFIX = "sigpath:stats:";
const SINCE = "sigpath:stats-since";

/** The day a count belongs to, in Berlin: SigPath's shoppers are in Germany, and "today" should be theirs. */
export function statDay(nowMs = Date.now()): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(nowMs);
}

/** Crawlers, link previews and monitors: their visits aren't people using SigPath. */
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|monitor|headless|lighthouse|curl|wget|python-requests|go-http-client/i;

export function isBot(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT.test(userAgent);
}

/**
 * Count events, once each. `kv` defaults to the shared database on the live
 * site; anywhere else (development, previews, tests) nothing is counted. Never throws.
 */
export async function count(
  events: StatEvent[],
  opts: { userAgent?: string | null; kv?: Kv | null; nowMs?: number } = {},
): Promise<void> {
  const known = events.filter((e) => (EVENTS as readonly string[]).includes(e));
  if (!known.length || isBot(opts.userAgent)) return;
  // Only the live site counts: a local run or a preview deployment shares the database, and would pad the totals.
  const kv = opts.kv === undefined ? (process.env.VERCEL_ENV === "production" ? UpstashKv.fromEnv() : null) : opts.kv;
  if (!kv) return;
  const key = PREFIX + statDay(opts.nowMs);
  try {
    await kv.pipeline([
      ...known.map((e) => ["HINCRBY", key, e, 1]),
      ["EXPIRE", key, KEEP_DAYS * 86400],
      // The first day anything was counted, kept for good: "counted since" on the stats page.
      ["SET", SINCE, statDay(opts.nowMs), "NX"],
    ]);
  } catch {
    // Not counted: the shopper's answer matters more than the tally.
  }
}

export type DayCounts = { day: string; counts: Record<StatEvent, number> };

const empty = (): Record<StatEvent, number> => Object.fromEntries(EVENTS.map((e) => [e, 0])) as Record<StatEvent, number>;

/** The last `days` days, oldest first, with zeros for days nothing happened. Null when there's no database. */
export async function readStats(days: number, opts: { kv?: Kv | null; nowMs?: number } = {}): Promise<DayCounts[] | null> {
  const kv = opts.kv === undefined ? UpstashKv.fromEnv() : opts.kv;
  if (!kv) return null;
  const now = opts.nowMs ?? Date.now();
  // Noon steps, so a daylight-saving change never skips or repeats a Berlin day.
  const today = Date.parse(`${statDay(now)}T12:00:00Z`);
  const list = Array.from({ length: days }, (_, i) => statDay(today - (days - 1 - i) * 86400000));
  const replies = await kv.pipeline(list.map((d) => ["HGETALL", PREFIX + d]));
  return list.map((day, i) => {
    const counts = empty();
    const r = replies[i];
    // Upstash answers HGETALL as [field, value, field, value, …].
    if (Array.isArray(r)) {
      for (let j = 0; j + 1 < r.length; j += 2) {
        const e = String(r[j]) as StatEvent;
        if (e in counts) counts[e] = Number(r[j + 1]) || 0;
      }
    }
    return { day, counts };
  });
}

/** Totals over the last `n` days of a reading. */
export function totalOf(days: DayCounts[], n: number): Record<StatEvent, number> {
  const t = empty();
  for (const d of days.slice(-n)) for (const e of EVENTS) t[e] += d.counts[e];
  return t;
}

/** The first day anything was counted ("2026-11-07"), or null: nothing yet, or no database. */
export async function countedSince(opts: { kv?: Kv | null } = {}): Promise<string | null> {
  const kv = opts.kv === undefined ? UpstashKv.fromEnv() : opts.kv;
  if (!kv) return null;
  const day = await kv.command<string | null>(["GET", SINCE]);
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}
