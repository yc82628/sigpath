/**
 * scripts/kv-check.ts — prove the shared database works, in isolation.
 *
 *   npx tsx scripts/kv-check.ts
 *
 * Writes one encrypted test record under a throwaway order id, reads it back,
 * lists it, deletes it, and checks nothing is left. Uses a random key, so the
 * record is unreadable to anything else; prints no secrets.
 */

import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import { UpstashKv } from "../lib/kv/upstash";
import { KvBackend } from "../lib/checkout/encrypted-store";
import { AddressStore } from "../lib/checkout/address-store";

for (const line of (() => { try { return readFileSync(".env.local", "utf8").split(/\r?\n/); } catch { return []; } })()) {
  const eq = line.indexOf("=");
  if (!line || line.startsWith("#") || eq === -1) continue;
  const k = line.slice(0, eq).trim();
  if (k && !(k in process.env)) process.env[k] = line.slice(eq + 1).trim();
}

async function main() {
  const kv = UpstashKv.fromEnv();
  if (!kv) throw new Error("No database configured: set KV_REST_API_URL and KV_REST_API_TOKEN in .env.local.");
  const t0 = Date.now();
  console.log("ping        ", await kv.command(["PING"]), `(${Date.now() - t0} ms)`);

  // A namespace of its own, so a failed run can never touch real orders.
  const store = new AddressStore(new KvBackend(kv, "kv-check", 300), randomBytes(32), "");
  const order = Keypair.generate().publicKey.toBase58();
  const record = {
    address: { name: "Test Person", line1: "1 Test Street", postcode: "10115", city: "Berlin", country: "DE" },
    buyer: Keypair.generate().publicKey.toBase58(),
    listing: { source: "stub", id: "kv-check", url: "https://example.invalid", title: "kv-check", amount: 100, currency: "EUR" },
    usdc: "1",
  };

  await store.put(order, record);
  const raw = await kv.command<string>(["GET", `sigpath:kv-check:${order}`]);
  const ttl = await kv.command<number>(["TTL", `sigpath:kv-check:${order}`]);
  const back = await store.get(order);
  const listed = (await store.list()).some((r) => r.order === order);
  const encrypted = !raw.includes("Berlin") && !raw.includes("Test Person");
  const deleted = await store.delete(order);
  const gone = (await store.get(order)) === null && !(await store.list()).some((r) => r.order === order);

  const checks: [string, boolean][] = [
    ["written and read back intact", JSON.stringify(back?.record) === JSON.stringify(record)],
    ["stored encrypted (no address in the database)", encrypted],
    [`expires on its own (TTL ${ttl}s)`, ttl > 0 && ttl <= 300],
    ["listed", listed],
    ["deleted", deleted],
    ["nothing left behind", gone],
  ];
  for (const [name, ok] of checks) console.log(ok ? "OK  " : "FAIL", name);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
