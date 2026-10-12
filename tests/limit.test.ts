import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Kv } from "../lib/kv/upstash";
import { clientId, clientIp, hit, limited, RULES, type Rule } from "../lib/guard/limit";

/** INCR and EXPIRE, in memory, shared like one database. */
class CounterKv implements Kv {
  counts = new Map<string, number>();
  ttl = new Map<string, number>();
  down = false;
  async command<T>(): Promise<T> {
    throw new Error("unused");
  }
  async pipeline(commands: (string | number)[][]) {
    if (this.down) throw new Error("Database pipeline failed (503).");
    return commands.map(([cmd, key, secs]) => {
      if (cmd === "INCR") {
        const n = (this.counts.get(String(key)) ?? 0) + 1;
        this.counts.set(String(key), n);
        return n;
      }
      if (cmd === "EXPIRE") return this.ttl.set(String(key), Number(secs)), 1;
      throw new Error(`unexpected ${cmd}`);
    });
  }
}

const rule: Rule = { name: "test-rule", limit: 3, windowSecs: 600, message: "slow down" };

test("a limit counted in the shared database holds across instances, and resets with the window", async () => {
  const db = new CounterKv();
  const t = 1_000_000_000_000;
  // Two "instances", one database: four requests from one client are four, not two and two.
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await hit(rule, "client-a", db, t + i)).ok);
  assert.deepEqual(results, [true, true, true, false]);
  assert.equal((await hit(rule, "client-b", db, t)).ok, true, "another client has its own count");
  const v = await hit(rule, "client-a", db, t);
  assert.ok(v.retryAfter > 0 && v.retryAfter <= 600);
  assert.equal((await hit(rule, "client-a", db, t + 600_000)).ok, true, "the next window starts afresh");
  // Every counter expires on its own.
  assert.ok([...db.ttl.values()].every((s) => s > 600 && s <= 700));
  assert.ok([...db.counts.keys()].every((k) => k.startsWith("sigpath:rl:test-rule:")));
});

test("a site-wide cap counts everyone together", async () => {
  const db = new CounterKv();
  const cap: Rule = { ...rule, name: "test-cap", limit: 2, global: true };
  assert.equal((await hit(cap, "a", db)).ok, true);
  assert.equal((await hit(cap, "b", db)).ok, true);
  assert.equal((await hit(cap, "c", db)).ok, false);
});

test("with the database down (or none), limits fall back to this instance's memory: never none, never everyone refused", async () => {
  const db = new CounterKv();
  db.down = true;
  const r: Rule = { ...rule, name: "test-fallback" };
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await hit(r, "x", db)).ok);
  assert.deepEqual(results, [true, true, true, false]);
  const n: Rule = { ...rule, name: "test-nodb" };
  for (let i = 0; i < 3; i++) assert.equal((await hit(n, "y", null)).ok, true);
  assert.equal((await hit(n, "y", null)).ok, false);
});

test("the database never sees an IP address: an HMAC of it, under a server secret", () => {
  const id = clientId("203.0.113.7", { QUOTE_SECRET: "s1" });
  assert.ok(!id.includes("203") && !id.includes("113"));
  assert.equal(id, clientId("203.0.113.7", { QUOTE_SECRET: "s1" }), "stable, so it can be counted");
  assert.notEqual(id, clientId("203.0.113.7", { QUOTE_SECRET: "s2" }), "different without the secret");
  assert.notEqual(id, clientId("203.0.113.8", { QUOTE_SECRET: "s1" }));
});

test("the client address is the one Vercel reports", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  assert.equal(clientIp(h({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientIp(h({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })), "198.51.100.1");
  assert.equal(clientIp(h({})), "local");
});

test("over the limit, a route answers 429 with Retry-After and the rule's message", async () => {
  const db = new CounterKv();
  const headers = { get: (k: string) => (k === "x-real-ip" ? "203.0.113.9" : null) };
  const r: Rule = { ...rule, name: "test-route", limit: 1 };
  assert.equal(await limited(headers, r, {}, db), null);
  const res = await limited(headers, r, {}, db);
  assert.equal(res?.status, 429);
  assert.ok(Number(res?.headers.get("retry-after")) > 0);
  assert.deepEqual(await res?.json(), { error: "slow down" });
  // Both of two rules are counted: the per-client limit and a daily cap.
  const capped = await limited(headers, [{ ...r, name: "test-other", limit: 5 }, { ...r, name: "test-cap-b", limit: 0, global: true }], {}, db);
  assert.equal(capped?.status, 429);
});

test("rule names are safe database keys", () => {
  for (const r of Object.values(RULES)) assert.match(r.name, /^[a-z-]+$/);
});

/** Routes that may answer without a limit, and why. Everything else must call one. */
const UNLIMITED: Record<string, string> = {
  "alerts/run": "the scheduler, behind ALERTS_CRON_SECRET",
  "ebay/account-deletion": "eBay's own notifications, signature-checked",
  "orders/[order]": "a read of a public on-chain order",
  "business/status": "a read of a public business record",
};

test("every API route either counts a rate limit or is listed above with a reason", () => {
  const root = join(__dirname, "..", "app", "api");
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === "route.ts") routes.push(p);
    }
  };
  walk(root);
  assert.ok(routes.length > 20);
  const missing = routes
    .map((p) => ({ name: p.slice(root.length + 1, -"/route.ts".length).replace(/\\/g, "/"), src: readFileSync(p, "utf8") }))
    .filter(({ name, src }) => !UNLIMITED[name] && !/\blimited\(|refuseUnpaidOrLimited\(/.test(src));
  assert.deepEqual(missing.map((m) => m.name), []);
});
