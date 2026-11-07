import { test } from "node:test";
import assert from "node:assert";
import { count, countedSince, isBot, readStats, statDay, totalOf, KEEP_DAYS, type StatEvent } from "../lib/stats/counter";
import type { Kv } from "../lib/kv/upstash";

/**
 * The usage counter keeps totals and nothing else: one number per event per
 * day. These tests pin that down, and that a count never gets in the way.
 */

class MemoryKv implements Kv {
  hashes = new Map<string, Map<string, number>>();
  strings = new Map<string, string>();
  expiries = new Map<string, number>();
  commands: (string | number)[][] = [];
  async command<T>(args: (string | number)[]): Promise<T> {
    return (await this.pipeline([args]))[0] as T;
  }
  async pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
    this.commands.push(...cmds);
    return cmds.map(([op, key, a, b]) => {
      const k = String(key);
      if (op === "HINCRBY") {
        const h = this.hashes.get(k) ?? new Map();
        this.hashes.set(k, h);
        h.set(String(a), (h.get(String(a)) ?? 0) + Number(b));
        return h.get(String(a));
      }
      if (op === "EXPIRE") return this.expiries.set(k, Number(a)), 1;
      if (op === "SET") {
        if (b === "NX" && this.strings.has(k)) return null;
        return this.strings.set(k, String(a)), "OK";
      }
      if (op === "GET") return this.strings.get(k) ?? null;
      if (op === "HGETALL") return [...(this.hashes.get(k) ?? new Map())].flatMap(([f, v]) => [f, String(v)]);
      throw new Error(`unexpected ${op}`);
    });
  }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const NOV7 = Date.parse("2026-11-07T10:00:00Z");

test("a count adds one per event to today's totals, and keeps nothing else", async () => {
  const kv = new MemoryKv();
  await count(["ext-shop", "good-deal"], { kv, userAgent: UA, nowMs: NOV7 });
  await count(["ext-shop"], { kv, userAgent: UA, nowMs: NOV7 });
  assert.deepStrictEqual([...kv.hashes.keys()], ["sigpath:stats:2026-11-07"], "one key per day, named by the date only");
  assert.deepStrictEqual(Object.fromEntries(kv.hashes.get("sigpath:stats:2026-11-07")!), { "ext-shop": 2, "good-deal": 1 });
  assert.strictEqual(kv.expiries.get("sigpath:stats:2026-11-07"), KEEP_DAYS * 86400, "dropped after 400 days");
  // Every argument written is a fixed key, an event name, a number or a date: nothing from a request.
  for (const c of kv.commands) for (const a of c) assert.match(String(a), /^(HINCRBY|EXPIRE|SET|NX|sigpath:stats(-since|:\d{4}-\d{2}-\d{2})|search|check|ext-shop|ext-ebay|good-deal|caution|click|\d+|\d{4}-\d{2}-\d{2})$/);
});

test("crawlers, missing user agents and unknown events aren't counted", async () => {
  const kv = new MemoryKv();
  await count(["search"], { kv, userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", nowMs: NOV7 });
  await count(["search"], { kv, userAgent: null, nowMs: NOV7 });
  await count(["nonsense" as StatEvent], { kv, userAgent: UA, nowMs: NOV7 });
  assert.strictEqual(kv.commands.length, 0);
  assert.ok(isBot("facebookexternalhit/1.1") && isBot("curl/8.4.0") && !isBot(UA));
});

test("no database or a failing one: nothing counted, nothing thrown", async () => {
  await count(["search"], { kv: null, userAgent: UA });
  const broken: Kv = { command: async () => assert.fail(), pipeline: async () => { throw new Error("down"); } };
  await count(["search"], { kv: broken, userAgent: UA });
  assert.strictEqual(await readStats(7, { kv: null }), null);
});

test("days are Berlin days", () => {
  assert.strictEqual(statDay(Date.parse("2026-11-07T23:30:00Z")), "2026-11-08", "00:30 in Berlin is the next day");
  assert.strictEqual(statDay(Date.parse("2026-07-01T21:59:00Z")), "2026-07-01", "23:59 in summer time");
});

test("the stats read back oldest first, with zeros for quiet days, and add up", async () => {
  const kv = new MemoryKv();
  const day = 86400000;
  await count(["search", "click"], { kv, userAgent: UA, nowMs: NOV7 - 9 * day });
  await count(["search"], { kv, userAgent: UA, nowMs: NOV7 - 2 * day });
  await count(["search", "caution"], { kv, userAgent: UA, nowMs: NOV7 });
  const days = (await readStats(30, { kv, nowMs: NOV7 }))!;
  assert.strictEqual(days.length, 30);
  assert.strictEqual(days[29].day, "2026-11-07");
  assert.strictEqual(days[0].day, "2026-10-09");
  assert.strictEqual(days[28].counts.search, 0, "a quiet day is zero");
  assert.deepStrictEqual([totalOf(days, 1).search, totalOf(days, 7).search, totalOf(days, 30).search], [1, 2, 3]);
  assert.strictEqual(totalOf(days, 30).click, 1);
  assert.strictEqual(await countedSince({ kv }), "2026-10-29", "the first day counted, never moved by later counts");
});
