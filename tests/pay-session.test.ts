import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { newSessionId, PAY_SESSION_SECS, PaySessionStore, ScanStates } from "../lib/checkout/pay-session";

/**
 * Paying by QR code (lib/checkout/pay-session.ts): until a phone scans, the
 * prices and the address wait as one encrypted session, fifteen minutes at
 * most; the waiting page only ever learns what the scan did.
 */

const ADDRESS = { name: "Ada Lovelace", line1: "Hauptstr. 1", postcode: "10115", city: "Berlin", country: "DE" };
const store = () => new PaySessionStore(mkdtempSync(join(tmpdir(), "pay-")), randomBytes(32), "pay-session");

test("a session id is 32 random bytes, written as a Solana address", () => {
  const a = newSessionId();
  assert.equal(new PublicKey(a).toBase58(), a);
  assert.notEqual(newSessionId(), a);
});

test("the session is encrypted, kept fifteen minutes, and gone after that", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pay-"));
  const s = new PaySessionStore(dir, randomBytes(32), "pay-session");
  const id = newSessionId();
  const now = Date.parse("2026-11-11T10:00:00Z");
  await s.put(id, { quotes: ["q1.sig"], address: ADDRESS }, now);
  // On disk: no address in the clear.
  const [file] = readdirSync(dir);
  assert.ok(!readFileSync(join(dir, file), "utf8").includes("Hauptstr"), "the address is never stored in the clear");
  assert.deepEqual((await s.live(id, now + 60_000))?.address.city, "Berlin");
  assert.equal(await s.live(id, now + (PAY_SESSION_SECS + 1) * 1000), null, "after fifteen minutes it's gone");
  assert.equal(readdirSync(dir).length, 0, "and deleted, also where the files backend can't expire it");
});

test("a session can't be overwritten, and a wrong id or key reads as nothing", async () => {
  const s = store();
  const id = newSessionId();
  await s.put(id, { quotes: ["q1.sig"], address: ADDRESS });
  await assert.rejects(s.put(id, { quotes: ["other.sig"], address: ADDRESS }), "write-once");
  assert.equal(await s.live("not-an-id"), null);
  assert.equal(await s.live(newSessionId()), null);
});

test("the scan's outcome holds no address, and runs out with the session", async () => {
  const scans = new ScanStates(null);
  const id = newSessionId();
  const now = Date.now();
  assert.equal(await scans.get(id, now), null);
  await scans.set(id, { state: "failed", message: "This wallet holds 0.00 USDC; the order needs 100.93 USDC.", shortfallUsdc: 100.93 }, now);
  assert.equal((await scans.get(id, now))?.state, "failed");
  await scans.set(id, { state: "scanned", orders: [{ order: "o", source: "ebay", id: "1", title: "t" }], validUntil: 100, buyer: "b" }, now);
  const s = await scans.get(id, now);
  assert.equal(s?.state, "scanned");
  assert.ok(!JSON.stringify(s).includes("Berlin"));
  assert.equal(await scans.get(id, now + (PAY_SESSION_SECS + 1) * 1000), null);
});
