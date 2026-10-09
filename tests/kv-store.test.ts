import { test } from "node:test";
import assert from "node:assert";
import { randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import { UpstashKv, type Kv } from "../lib/kv/upstash";
import { KvBackend, FileBackend, backendFromEnv } from "../lib/checkout/encrypted-store";
import { AddressStore, RETENTION_MAX_SECONDS } from "../lib/checkout/address-store";

/** Just enough Redis, in memory, with expiries on a clock the test controls. */
class FakeKv implements Kv {
  strings = new Map<string, { value: string; expiresAt: number }>();
  sets = new Map<string, Set<string>>();
  now = 0;
  log: (string | number)[][] = [];

  private live(key: string) {
    const e = this.strings.get(key);
    if (e && e.expiresAt <= this.now) this.strings.delete(key);
    return this.strings.get(key);
  }

  async command<T>(args: (string | number)[]): Promise<T> {
    this.log.push(args);
    const [cmd, ...rest] = args.map(String);
    switch (cmd) {
      case "SET": {
        const [key, value, nx, ex, secs] = rest;
        assert.equal(nx, "NX");
        assert.equal(ex, "EX");
        if (this.live(key)) return null as T;
        this.strings.set(key, { value, expiresAt: this.now + Number(secs) });
        return "OK" as T;
      }
      case "GET":
        return (this.live(rest[0])?.value ?? null) as T;
      case "DEL":
        return (this.live(rest[0]) && this.strings.delete(rest[0]) ? 1 : 0) as T;
      case "MGET":
        return rest.map((k) => this.live(k)?.value ?? null) as T;
      case "SADD": {
        const s = this.sets.get(rest[0]) ?? new Set();
        rest.slice(1).forEach((m) => s.add(m));
        this.sets.set(rest[0], s);
        return 1 as T;
      }
      case "SREM":
        rest.slice(1).forEach((m) => this.sets.get(rest[0])?.delete(m));
        return 1 as T;
      case "SMEMBERS":
        return [...(this.sets.get(rest[0]) ?? [])] as T;
    }
    throw new Error(`unexpected ${cmd}`);
  }

  async pipeline(commands: (string | number)[][]) {
    const out = [];
    for (const c of commands) out.push(await this.command(c));
    return out;
  }
}

const order = () => Keypair.generate().publicKey.toBase58();
const address = { name: "A Person", line1: "1 Street", postcode: "10115", city: "Berlin", country: "DE" };
const record = { address, buyer: order(), listing: { source: "ebay", id: "1", url: "https://x", title: "t", amount: 100, currency: "EUR" }, usdc: "1" };

test("the database holds only ciphertext, under a fixed key, with an expiry", async () => {
  const kv = new FakeKv();
  const store = new AddressStore(new KvBackend(kv, "checkout", RETENTION_MAX_SECONDS), randomBytes(32), "");
  const o = order();
  await store.put(o, record);

  const stored = kv.strings.get(`sigpath:checkout:${o}`)!;
  assert.ok(stored, "keyed by order");
  assert.equal(stored.expiresAt, RETENTION_MAX_SECONDS, "expires at the retention limit");
  assert.ok(!stored.value.includes("Berlin") && !stored.value.includes("A Person"), "no plaintext");
  assert.deepEqual((await store.get(o))!.record, record);
  assert.deepEqual((await store.list()).map((r) => r.order), [o]);
});

test("the database store is write-once, like the files", async () => {
  const store = new AddressStore(new KvBackend(new FakeKv(), "checkout", 3600), randomBytes(32), "");
  const o = order();
  await store.put(o, record);
  await assert.rejects(store.put(o, { ...record, address: { ...address, city: "Elsewhere" } }), /already exists/);
  assert.equal((await store.get(o))!.record.address.city, "Berlin");
});

test("delete removes the record and its index entry", async () => {
  const kv = new FakeKv();
  const store = new AddressStore(new KvBackend(kv, "checkout", 3600), randomBytes(32), "");
  const o = order();
  await store.put(o, record);
  assert.equal(await store.delete(o), true);
  assert.equal(await store.get(o), null);
  assert.equal(kv.sets.get("sigpath:checkout:index")!.size, 0);
  assert.equal(await store.delete(o), false, "a second delete reports nothing to delete");
});

test("a record the database expired disappears from the list, index included", async () => {
  const kv = new FakeKv();
  const store = new AddressStore(new KvBackend(kv, "checkout", 60), randomBytes(32), "");
  await store.put(order(), record);
  kv.now = 61;
  assert.deepEqual(await store.list(), []);
  assert.equal(kv.sets.get("sigpath:checkout:index")!.size, 0);
});

test("a record can't be read under another store's key, even in the same database", async () => {
  const kv = new FakeKv();
  const key = randomBytes(32);
  const a = new AddressStore(new KvBackend(kv, "checkout", 3600), key, "");
  const o = order();
  await a.put(o, record);
  // Copy the ciphertext into another namespace and read it as a different purpose.
  kv.strings.set(`sigpath:report:${o}`, kv.strings.get(`sigpath:checkout:${o}`)!);
  const other = new AddressStore(new KvBackend(kv, "report", 3600), key, "report");
  await assert.rejects(other.get(o));
});

test("an order id that isn't a public key never becomes a database key", async () => {
  const kv = new FakeKv();
  const store = new AddressStore(new KvBackend(kv, "checkout", 3600), randomBytes(32), "");
  await assert.rejects(store.put("sigpath:checkout:index", record), /Invalid order id/);
  assert.equal(kv.log.length, 0);
});

test("the database is used when configured, files otherwise or when a directory is set", () => {
  const db = { KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" };
  const opts = { defaultDir: "d", namespace: "checkout", ttlSecs: 60 };
  assert.ok(backendFromEnv(db, opts) instanceof KvBackend);
  assert.ok(backendFromEnv({}, opts) instanceof FileBackend);
  assert.ok(backendFromEnv({ ...db }, { ...opts, explicitDir: "here" }) instanceof FileBackend);
  // Only https: a token is never sent in the clear.
  assert.equal(UpstashKv.fromEnv({ KV_REST_API_URL: "http://x.upstash.io", KV_REST_API_TOKEN: "t" }), null);
  assert.ok(UpstashKv.fromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }));
  // Quotes kept from a copy-paste are fine.
  assert.ok(UpstashKv.fromEnv({ KV_REST_API_URL: '"https://x.upstash.io"', KV_REST_API_TOKEN: '"t"' }));
});

test("the REST client sends the command with the token, fresh, and never echoes arguments in errors", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (body: unknown, status = 200) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  const ok = new UpstashKv("https://x.upstash.io", "tok", reply({ result: "OK" }));
  assert.equal(await ok.command(["SET", "k", "secret-value"]), "OK");
  assert.equal(calls[0].url, "https://x.upstash.io");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer tok");
  assert.equal(calls[0].init.cache, "no-store");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), ["SET", "k", "secret-value"]);

  const bad = new UpstashKv("https://x.upstash.io", "tok", reply({ error: "WRONGTYPE secret-value" }));
  await assert.rejects(bad.command(["SET", "k", "secret-value"]), (e: Error) => !e.message.includes("secret-value"));
  const down = new UpstashKv("https://x.upstash.io", "tok", reply({}, 500));
  await assert.rejects(down.command(["GET", "k"]), /500/);
});
