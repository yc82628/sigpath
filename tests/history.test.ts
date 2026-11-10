import { test } from "node:test";
import assert from "node:assert";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Kv } from "../lib/kv/upstash";
import { productKey, readHistory, recordMarket, summarize, type HistoryDay } from "../lib/marketplace/history";
import { countBy } from "../lib/stats/counter";
import { MESSAGES } from "../lib/i18n/messages";
import PriceHistory from "../app/components/PriceHistory";

/**
 * A product's days on eBay (lib/marketplace/history.ts): one typical price per
 * day, under a one-way code of the product's name; and the judged-offers
 * counts on /stats.
 */

// tsx compiles the component's JSX to React.createElement (Next's own build doesn't need this).
(globalThis as unknown as { React: typeof React }).React = React;

class MemoryKv implements Kv {
  hashes = new Map<string, Map<string, string>>();
  expiries = new Map<string, number>();
  async command<T>(args: (string | number)[]): Promise<T> {
    return (await this.pipeline([args]))[0] as T;
  }
  async pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
    return cmds.map(([op, key, ...rest]) => {
      const k = String(key);
      const h = this.hashes.get(k) ?? new Map<string, string>();
      this.hashes.set(k, h);
      if (op === "HSET") return h.set(String(rest[0]), String(rest[1])), 1;
      if (op === "HGET") return h.get(String(rest[0])) ?? null;
      if (op === "HMGET") return rest.map((f) => h.get(String(f)) ?? null);
      if (op === "HINCRBY") return h.set(String(rest[0]), String(Number(h.get(String(rest[0])) ?? 0) + Number(rest[1]))), 1;
      if (op === "EXPIRE") return this.expiries.set(k, Number(rest[0])), 1;
      if (op === "SET") return "OK";
      throw new Error(`unexpected ${op}`);
    });
  }
}

const DAY = 86_400_000;
const NOV10 = Date.parse("2026-11-10T10:00:00Z");

test("one history per product, whatever the spelling, and never the name itself", () => {
  assert.equal(productKey("Sony WH-1000XM5"), productKey("sony wh1000xm5"));
  assert.equal(productKey("Sony WH-1000XM5"), productKey("Sony WH-1000XM5 Kopfhörer, Schwarz – Noise Cancelling"), "a shop's long title is the same product");
  assert.notEqual(productKey("Sony WH-1000XM5"), productKey("Sony WH-1000XM4"));
  assert.match(productKey("Sony WH-1000XM5"), /^[0-9a-f]{32}$/, "a one-way code, not the words");
});

test("each day keeps one typical price per condition; a new price doesn't erase the used one", async () => {
  const kv = new MemoryKv();
  await recordMarket("Sony WH-1000XM5", { n: 20499, currency: "EUR" }, { kv, nowMs: NOV10 });
  await recordMarket("sony wh1000xm5", { u: 14900, currency: "EUR" }, { kv, nowMs: NOV10 + 3600_000 });
  await recordMarket("Sony WH-1000XM5", { n: 19999, u: null, currency: "EUR" }, { kv, nowMs: NOV10 - DAY });
  const days = await readHistory("Sony WH-1000XM5", { kv, nowMs: NOV10 });
  assert.deepEqual(days, [
    { day: "2026-11-09", n: 19999, u: undefined, currency: "EUR" },
    { day: "2026-11-10", n: 20499, u: 14900, currency: "EUR" },
  ]);
  const [key] = [...kv.hashes.keys()];
  assert.ok(!key.includes("sony") && !key.includes("1000"), "the database never sees the product's name");
  assert.equal(kv.expiries.get(key), 400 * 86400);
  // Nothing to note, nothing written; no database, nothing read.
  await recordMarket("Sony WH-1000XM5", { n: null, currency: "EUR" }, { kv: null });
  assert.deepEqual(await readHistory("Sony WH-1000XM5", { kv: null }), []);
});

test("the summary: the 30-day low, and the trend once there's a week before last to compare with", () => {
  const day = (i: number) => new Date(NOV10 - (20 - i) * DAY).toISOString().slice(0, 10);
  const falling: HistoryDay[] = Array.from({ length: 21 }, (_, i) => ({ day: day(i), n: 25000 - i * 300, currency: "EUR" }));
  const s = summarize(falling, "new", "EUR")!;
  assert.equal(s.days, 21);
  assert.equal(s.low.amount, 19000);
  assert.equal(s.low.day, day(20));
  assert.equal(s.trend, "falling");
  const flat = falling.map((d) => ({ ...d, n: 20000 }));
  assert.equal(summarize(flat, "new", "EUR")!.trend, "steady");
  assert.equal(summarize(falling.map((d, i) => ({ ...d, n: 18000 + i * 300 })), "new", "EUR")!.trend, "rising");
  // Too little to say: under three days, or no week before last.
  assert.equal(summarize(falling.slice(-2), "new", "EUR"), null);
  assert.equal(summarize(falling.slice(-5), "new", "EUR")!.trend, null);
  assert.equal(summarize(falling, "used", "EUR"), null, "no used prices");
  assert.equal(summarize(falling, "new", "USD"), null, "another currency isn't mixed in");
});

test("the history is drawn as a line with the low, and the price being checked marked", () => {
  const days: HistoryDay[] = [
    { day: "2026-11-01", n: 21000, currency: "EUR" },
    { day: "2026-11-02", n: 20000, currency: "EUR" },
    { day: "2026-11-03", n: 19500, currency: "EUR" },
  ];
  const html = renderToStaticMarkup(
    createElement(PriceHistory, {
      h: summarize(days, "new", "EUR")!,
      t: MESSAGES.de.history,
      lang: "de",
      money: (a: number) => `${(a / 100).toFixed(2).replace(".", ",")} €`,
      price: 18900,
    }),
  );
  assert.match(html, /Die letzten 30 Tage auf eBay/);
  assert.match(html, /Niedrigster typischer Preis: 195,00 € \(3\. Nov\.\)/);
  assert.match(html, /unter allem aus den letzten 30 Tagen/, "189 € is below the low");
  assert.match(html, /<polyline points="/);
  assert.match(html, /price-history-now/);
});

test("a search's offers are counted by verdict, several at a time", async () => {
  const kv = new MemoryKv();
  await countBy({ "judged-checked": 12, "judged-caution": 3, "judged-unchecked": 0 }, { kv, nowMs: NOV10, userAgent: "Mozilla/5.0 Chrome/130.0" });
  const h = kv.hashes.get("sigpath:stats:2026-11-10")!;
  assert.equal(h.get("judged-checked"), "12");
  assert.equal(h.get("judged-caution"), "3");
  assert.ok(!h.has("judged-unchecked"), "a zero writes nothing");
  await countBy({ "judged-checked": 5 }, { kv, nowMs: NOV10, userAgent: "Googlebot/2.1" });
  assert.equal(h.get("judged-checked"), "12", "crawlers aren't counted");
});
