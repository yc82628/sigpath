import { test } from "node:test";
import assert from "node:assert";
import { webcrypto } from "node:crypto";
import { sha256Hex, subjectHash, hexToBytes, bytesToHex } from "../lib/crypto/hash";

// Web Crypto under Node, so the same code runs in both places.
if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

test("same bytes produce the same hash", async () => {
  const a = await sha256Hex(new Uint8Array([1, 2, 3]));
  const b = await sha256Hex(new Uint8Array([1, 2, 3]));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

// The namespace prefix is the whole point: without it, the same handle on two
// platforms would collide and an attestation about one would read as being
// about the other.
test("the same handle on different platforms does not collide", async () => {
  const gh = bytesToHex(await subjectHash("github", "alice"));
  const x = bytesToHex(await subjectHash("x", "alice"));
  assert.notEqual(gh, x);
});

test("subject hashing is case and whitespace insensitive", async () => {
  const a = bytesToHex(await subjectHash("github", "Alice"));
  const b = bytesToHex(await subjectHash("GitHub", "  alice "));
  assert.equal(a, b);
});

test("subject hash is 32 bytes, matching the PDA seed", async () => {
  assert.equal((await subjectHash("github", "alice")).length, 32);
});

test("hex round-trips", () => {
  const bytes = new Uint8Array([0, 15, 16, 255]);
  assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
  assert.deepEqual(hexToBytes("0x000f10ff"), bytes);
});
