import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Kv } from "../lib/kv/upstash";
import { UpstashKv } from "../lib/kv/upstash";
import { FileTable, KvTable, tableFromEnv, type Table } from "../lib/kv/table";
import { DecisionLog, type Decision } from "../lib/reports/reports";
import { CaseLog } from "../lib/reports/cases";
import { VerifiedSellerLog, type Badge } from "../lib/sellers/verified-log";
import { BusinessLog } from "../lib/sellers/business";
import { WatchStore } from "../lib/alerts/watches";

/** Just enough Redis hashes, in memory. Shared by several "instances" to stand in for one database. */
class FakeHashKv implements Kv {
  hashes = new Map<string, Map<string, string>>();
  log: string[][] = [];

  private h(key: string) {
    let m = this.hashes.get(key);
    if (!m) this.hashes.set(key, (m = new Map()));
    return m;
  }

  async command<T>(args: (string | number)[]): Promise<T> {
    const [cmd, key, ...rest] = args.map(String);
    this.log.push([cmd, key, ...rest]);
    const h = this.h(key);
    switch (cmd) {
      case "HGETALL":
        return [...h].flat() as T;
      case "HGET":
        return (h.get(rest[0]) ?? null) as T;
      case "HSET": {
        let added = 0;
        for (let i = 0; i < rest.length; i += 2) {
          if (!h.has(rest[i])) added++;
          h.set(rest[i], rest[i + 1]);
        }
        return added as T;
      }
      case "HSETNX":
        if (h.has(rest[0])) return 0 as T;
        h.set(rest[0], rest[1]);
        return 1 as T;
      case "HDEL":
        return rest.filter((f) => h.delete(f)).length as T;
    }
    throw new Error(`unexpected ${cmd}`);
  }

  async pipeline(commands: (string | number)[][]) {
    const out = [];
    for (const c of commands) out.push(await this.command(c));
    return out;
  }
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "sigpath-table-")), "t.json");

for (const [name, make] of [
  ["file", () => new FileTable<{ n: number }>(tmpFile())],
  ["database", () => new KvTable<{ n: number }>(new FakeHashKv(), "test-table")],
] as [string, () => Table<{ n: number }>][]) {
  test(`table (${name}): get, set, set-if-absent, set many, delete`, async () => {
    const t = make();
    assert.deepEqual(await t.all(), {});
    assert.equal(await t.get("a"), null);
    await t.set("a", { n: 1 });
    assert.deepEqual(await t.get("a"), { n: 1 });
    assert.equal(await t.setIfAbsent("a", { n: 2 }), false, "an existing record is not overwritten");
    assert.deepEqual(await t.get("a"), { n: 1 });
    assert.equal(await t.setIfAbsent("b", { n: 2 }), true);
    await t.setMany({ c: { n: 3 }, a: { n: 10 } });
    assert.deepEqual(await t.all(), { a: { n: 10 }, b: { n: 2 }, c: { n: 3 } });
    assert.equal(await t.delete("a", "c", "missing"), 2);
    assert.equal(await t.delete(), 0);
    assert.deepEqual(await t.all(), { b: { n: 2 } });
    assert.equal(await t.get("toString"), null, "no prototype properties");
  });
}

test("table (database): one hash per table, and a field that isn't JSON is skipped", async () => {
  const kv = new FakeHashKv();
  const t = new KvTable<{ n: number }>(kv, "verified-sellers");
  await t.set("ebay:alice", { n: 1 });
  assert.ok(kv.hashes.get("sigpath:table:verified-sellers")?.has("ebay:alice"));
  kv.hashes.get("sigpath:table:verified-sellers")!.set("ebay:bad", "{not json");
  assert.deepEqual(await t.all(), { "ebay:alice": { n: 1 } });
  assert.equal(await t.get("ebay:bad"), null);
  assert.throws(() => new KvTable(kv, "../x"), /Invalid table name/);
});

test("the database when one is configured, the file otherwise, and an explicit file always wins", () => {
  const db = { KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" };
  const opts = { defaultFile: "/data/x.json", name: "x" };
  assert.ok(tableFromEnv(db, opts) instanceof KvTable);
  assert.ok(tableFromEnv({}, opts) instanceof FileTable);
  const explicit = tableFromEnv({ ...db }, { ...opts, explicitFile: "/my/file.json" });
  assert.ok(explicit instanceof FileTable && explicit.file === "/my/file.json");
});

test("every store in one process shares one database client (and its read-your-writes token)", () => {
  const env = { KV_REST_API_URL: "https://shared.upstash.io", KV_REST_API_TOKEN: "t" };
  assert.strictEqual(UpstashKv.fromEnv(env), UpstashKv.fromEnv({ ...env }));
  assert.notStrictEqual(UpstashKv.fromEnv(env), UpstashKv.fromEnv({ ...env, KV_REST_API_TOKEN: "other" }));
});

const badge = (wallet: string, at = 100): Badge => ({
  wallet,
  attestation: `att-${wallet}`,
  mint: `mint-${wallet}`,
  tokenAccount: `ta-${wallet}`,
  proof: { source: "ebay", listingId: "1" },
  verifiedAt: at,
  expiresAt: at + 1000,
});

test("two instances on one database: badges issued on each are seen by both, neither lost", async () => {
  // What Vercel does: requests land on different instances. With a file in each
  // instance's temp dir, the badge issued on A was missing on B.
  const db = new FakeHashKv();
  const a = new VerifiedSellerLog(new KvTable(db, "verified-sellers"));
  const b = new VerifiedSellerLog(new KvTable(db, "verified-sellers"));
  await Promise.all([a.record("ebay:alice", badge("A")), b.record("ebay:bob", badge("B"))]);
  assert.deepEqual(Object.keys(await a.all()).sort(), ["ebay:alice", "ebay:bob"]);
  assert.equal((await b.get("ebay:alice"))?.current.wallet, "A");

  // The same handle claimed on both at once: one badge, the other refused.
  const results = await Promise.allSettled([a.record("ebay:carol", badge("C1")), b.record("ebay:carol", badge("C2"))]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);

  // Revoked, then re-issued: the old one moves to history.
  await a.markRevoked("ebay:alice", { at: 200, reason: "upheld report" });
  await b.record("ebay:alice", badge("A2", 300));
  const e = await a.get("ebay:alice");
  assert.equal(e?.current.wallet, "A2");
  assert.equal(e?.history[0].revoked?.reason, "upheld report");
  assert.equal(await a.remove("ebay:alice"), true);
  assert.equal(await a.get("ebay:alice"), null);
});

const decision = (sellerKey: string): Decision => ({
  status: "upheld",
  sellerKey,
  category: "counterfeit",
  decidedAt: 100,
  evidenceSha256: "e",
  listingHash: "l",
});

test("decisions on the database: recorded once, even when two requests race; reversal and renaming", async () => {
  const db = new FakeHashKv();
  const a = new DecisionLog(new KvTable(db, "report-decisions"));
  const b = new DecisionLog(new KvTable(db, "report-decisions"));
  const results = await Promise.allSettled([a.record("order1", decision("ebay:x")), b.record("order1", decision("ebay:y"))]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const xWon = (await b.get("order1"))!.sellerKey === "ebay:x";
  await a.record("order2", decision("ebay:x"));
  assert.equal((await b.upheldCounts()).get("ebay:x"), xWon ? 2 : 1);

  await b.markReversed("order2", { at: 200 });
  await assert.rejects(a.markReversed("order2", { at: 300 }), /already been reversed/);
  assert.equal(await a.renameSeller("ebay:x", "ebay:deleted-1"), xWon ? 2 : 1);
  assert.equal((await b.get("order2"))?.sellerKey, "ebay:deleted-1");
  assert.equal((await b.get("order2"))?.reversal?.at, 200, "renaming keeps the reversal");
});

test("cases, businesses and price alerts on the database", async () => {
  const db = new FakeHashKv();
  const cases = new CaseLog(new KvTable(db, "report-cases"));
  await cases.open("o1", "ebay:x", 10);
  await assert.rejects(cases.open("o1", "ebay:x", 11), /already exists/);
  await cases.markNotified("o1", 20);
  await cases.markNotified("o1", 30);
  await cases.respond("o1", "reply", { text: "It was genuine, here is the receipt.", at: 40 });
  await assert.rejects(cases.respond("o1", "reply", { text: "Second try at a reply", at: 50 }), /already submitted/);
  assert.equal((await new CaseLog(new KvTable(db, "report-cases")).get("o1"))?.notifiedAt, 20, "the first notice starts the window");
  await cases.open("o2", "ebay:x", 12);
  assert.equal(await cases.removeSeller("ebay:x"), 2);

  const biz = new BusinessLog(new KvTable(db, "businesses"));
  const [b1, b2] = await Promise.all([
    biz.update("W1", (b) => ({ ...b, website: "a.example" }), 5),
    new BusinessLog(new KvTable(db, "businesses")).update("W1", (b) => ({ ...b }), 5),
  ]);
  assert.equal(b1.id, b2.id, "two first requests for one wallet make one business");
  assert.equal((await biz.byId(b1.id))?.wallet, "W1");
  assert.equal(await biz.remove("W1"), true);

  const alerts = new WatchStore(new KvTable(db, "price-alerts"));
  const w = await alerts.add({ endpoint: "E", query: "airpods pro 2", group: "new", target: { amount: 20000, currency: "EUR" } }, 1000);
  await alerts.update(w.id, { pending: { title: "t", body: "b", url: "/search?q=airpods", at: 1001 } });
  assert.equal((await alerts.collect("E")).length, 1);
  assert.equal((await alerts.collect("E")).length, 0, "collected once");
  assert.equal(await alerts.remove(w.id, "someone else"), false, "only the endpoint that owns it");
  assert.equal(await alerts.sweep(1000 + 31 * 24 * 3600), 1);
  assert.deepEqual(await alerts.all(), {});
});
