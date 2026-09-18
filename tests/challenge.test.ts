import { test } from "node:test";
import assert from "node:assert";
import { webcrypto } from "node:crypto";
import nacl from "tweetnacl";
import { sha256Bytes } from "../lib/crypto/hash";
import { bindChallenge } from "../lib/crypto/sign";

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

// These guard the anti-replay property: a signature is only valid for the exact
// (photo, challenge) pair. Swap either one and verification must fail.
test("challenge-bound signature verifies for the right hash+nonce", async () => {
  const kp = nacl.sign.keyPair();
  const hash = await sha256Bytes(new Uint8Array([1, 2, 3]));
  const nonce = new Uint8Array(32).fill(7);
  const sig = nacl.sign.detached(bindChallenge(hash, nonce), kp.secretKey);
  assert.ok(nacl.sign.detached.verify(bindChallenge(hash, nonce), sig, kp.publicKey));
  assert.equal(b64(kp.publicKey).length > 0, true);
});

test("a signature from a DIFFERENT nonce is rejected (replay defence)", async () => {
  const kp = nacl.sign.keyPair();
  const hash = await sha256Bytes(new Uint8Array([1, 2, 3]));
  const oldNonce = new Uint8Array(32).fill(7);
  const freshNonce = new Uint8Array(32).fill(9);
  // Attacker signed the photo earlier, against an old challenge.
  const staleSig = nacl.sign.detached(bindChallenge(hash, oldNonce), kp.secretKey);
  // It must not satisfy today's challenge.
  assert.equal(
    nacl.sign.detached.verify(bindChallenge(hash, freshNonce), staleSig, kp.publicKey),
    false
  );
});

test("a signature for a DIFFERENT photo is rejected", async () => {
  const kp = nacl.sign.keyPair();
  const nonce = new Uint8Array(32).fill(7);
  const hashA = await sha256Bytes(new Uint8Array([1, 2, 3]));
  const hashB = await sha256Bytes(new Uint8Array([4, 5, 6]));
  const sigA = nacl.sign.detached(bindChallenge(hashA, nonce), kp.secretKey);
  assert.equal(nacl.sign.detached.verify(bindChallenge(hashB, nonce), sigA, kp.publicKey), false);
});

test("bindChallenge rejects wrong-sized inputs", () => {
  assert.throws(() => bindChallenge(new Uint8Array(16), new Uint8Array(32)));
  assert.throws(() => bindChallenge(new Uint8Array(32), new Uint8Array(8)));
});
