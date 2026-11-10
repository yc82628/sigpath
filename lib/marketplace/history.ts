/**
 * lib/marketplace/history.ts — what a product has cost on eBay, day by day.
 *
 * WHY
 * One market price says what a product costs today; a month of them says
 * whether today is a good day to buy: "lowest in 30 days", rising, falling.
 * That's what price-history sites are used for, and what a Black Friday
 * "deal" is measured against.
 *
 * WHAT IS KEPT
 * Per product, one typical price per day (the market's median, market.ts),
 * new and used apart, in SigPath's database (Upstash). The product is stored
 * under a one-way code of its name (SHA-256 of the name, letters and digits
 * only), never the name or the search itself: the history can be read for a
 * product you name, not listed to see what was searched. Nothing about who
 * searched is kept with it. Each product's days are kept 400 days, then
 * dropped by the database.
 *
 * WHEN
 * Written whenever SigPath measures a market anyway (a search, a price check,
 * an extension check), on the live site only; a write that fails is skipped.
 */

import { createHash } from "crypto";
import type { Kv } from "../kv/upstash";
import { UpstashKv } from "../kv/upstash";
import { statDay } from "../stats/counter";
import { shortQuery } from "./price-check";

const PREFIX = "sigpath:hist:";
export const HISTORY_KEEP_DAYS = 400;
/** The window "lowest" and the trend are read over. */
export const HISTORY_WINDOW = 30;

/** One day's typical prices, in minor units; a condition with no market that day is left out. */
export interface HistoryDay {
  day: string;
  n?: number;
  u?: number;
  currency: string;
}

/**
 * The one-way code a product's history is kept under. The product's search
 * words (shortQuery), letters and digits only, lowercased: "Sony WH-1000XM5",
 * "sony wh1000xm5" and a shop's long title for it share one history.
 */
export function productKey(name: string): string {
  const words = (shortQuery(name) || name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return createHash("sha256").update(`sigpath-history-v1\n${words}`).digest("hex").slice(0, 32);
}

function kvFor(kv: Kv | null | undefined, write: boolean): Kv | null {
  if (kv !== undefined) return kv;
  // Only the live site writes: a local run or a preview shares the database, and would pad the history.
  if (write && process.env.VERCEL_ENV !== "production") return null;
  return UpstashKv.fromEnv();
}

/** Note today's typical prices for a product. Never throws. */
export async function recordMarket(
  name: string,
  prices: { n?: number | null; u?: number | null; currency: string },
  opts: { kv?: Kv | null; nowMs?: number } = {},
): Promise<void> {
  const n = prices.n && prices.n > 0 ? Math.round(prices.n) : undefined;
  const u = prices.u && prices.u > 0 ? Math.round(prices.u) : undefined;
  if ((!n && !u) || !name.trim()) return;
  const kv = kvFor(opts.kv, true);
  if (!kv) return;
  const key = PREFIX + productKey(name);
  const day = statDay(opts.nowMs);
  try {
    // Today's earlier note for the condition not measured now stays: a search of used listings doesn't erase the new price.
    const before = await kv.command<string | null>(["HGET", key, day]).catch(() => null);
    const old = before ? (JSON.parse(before) as Partial<HistoryDay>) : {};
    const today: Omit<HistoryDay, "day"> = { currency: prices.currency, ...(old.currency === prices.currency ? old : {}), ...(n ? { n } : {}), ...(u ? { u } : {}) };
    await kv.pipeline([
      ["HSET", key, day, JSON.stringify({ n: today.n, u: today.u, currency: today.currency })],
      ["EXPIRE", key, HISTORY_KEEP_DAYS * 86400],
    ]);
  } catch {
    // Not noted: the shopper's answer matters more.
  }
}

/** The last `days` days of a product's history that have a price, oldest first. Empty without a database. */
export async function readHistory(name: string, opts: { kv?: Kv | null; days?: number; nowMs?: number } = {}): Promise<HistoryDay[]> {
  const kv = kvFor(opts.kv, false);
  if (!kv || !name.trim()) return [];
  const days = opts.days ?? HISTORY_WINDOW;
  const now = opts.nowMs ?? Date.now();
  // Noon steps, so a daylight-saving change never skips or repeats a Berlin day.
  const today = Date.parse(`${statDay(now)}T12:00:00Z`);
  const list = Array.from({ length: days }, (_, i) => statDay(today - (days - 1 - i) * 86400000));
  try {
    const raw = await kv.command<(string | null)[]>(["HMGET", PREFIX + productKey(name), ...list]);
    return list.flatMap((day, i) => {
      const v = raw?.[i];
      if (!v) return [];
      try {
        const d = JSON.parse(v) as Partial<HistoryDay>;
        return typeof d.currency === "string" ? [{ day, n: d.n, u: d.u, currency: d.currency }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export type Trend = "falling" | "rising" | "steady";

export interface HistorySummary {
  /** Days with a price in the window. */
  days: number;
  /** The lowest typical price in the window, and its day. */
  low: { amount: number; day: string };
  /** Whether the price is going down or up: the last three days against the week before last. Null with too little history. */
  trend: Trend | null;
  /** The typical prices, oldest first, for a small chart. */
  series: number[];
  currency: string;
}

/** Fewer days than this say nothing yet. */
export const MIN_HISTORY_DAYS = 3;
/** A change smaller than this, either way, is steady. */
const TREND_PCT = 5;

/** The window, summed up for one condition. Null when there are too few days to say anything. */
export function summarize(history: HistoryDay[], group: "new" | "used", currency: string): HistorySummary | null {
  const points = history
    .map((d) => ({ day: d.day, v: group === "new" ? d.n : d.u, currency: d.currency }))
    .filter((p): p is { day: string; v: number; currency: string } => typeof p.v === "number" && p.v > 0 && p.currency === currency);
  if (points.length < MIN_HISTORY_DAYS) return null;
  const low = points.reduce((a, b) => (b.v < a.v ? b : a));
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const recent = points.slice(-3).map((p) => p.v);
  // The week before last, by date: days 8 to 14 back from the newest point.
  const newest = Date.parse(`${points[points.length - 1].day}T12:00:00Z`);
  const earlier = points
    .filter((p) => {
      const back = (newest - Date.parse(`${p.day}T12:00:00Z`)) / 86400000;
      return back >= 7 && back <= 14;
    })
    .map((p) => p.v);
  let trend: Trend | null = null;
  if (earlier.length >= 2) {
    const change = ((avg(recent) - avg(earlier)) / avg(earlier)) * 100;
    trend = change <= -TREND_PCT ? "falling" : change >= TREND_PCT ? "rising" : "steady";
  }
  return { days: points.length, low: { amount: low.v, day: low.day }, trend, series: points.map((p) => p.v), currency };
}
