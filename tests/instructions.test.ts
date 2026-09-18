import { test } from "node:test";
import assert from "node:assert";
import { webcrypto } from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  issueIx,
  revokeIx,
  linkBaseIx,
  discriminator,
  METHOD,
  NO_BASE_UID,
  ISSUE_LAYOUT,
} from "../lib/chains/solana/instructions";
import { attestationPda } from "../lib/chains/solana/pda";
import { subjectHash } from "../lib/crypto/hash";

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

const PROGRAM = new PublicKey("Cy8r6RPdimsDDDKvmyW4ZmhmJYqagFBeGtn8fpkPmZw4");
const ISSUER = new PublicKey("AaFcCzgJ53SPpqheu8KGM6fA3i4cwd57SL8goz6jdfXg");
const SUBJECT = new Uint8Array(32).fill(7);

// ---------------------------------------------------------------------------
// These tests exist because nothing else checks this boundary. There is no IDL
// and no shared type between lib.rs and the encoder — if the encoding drifts,
// only these fail.
// ---------------------------------------------------------------------------

test("discriminator uses Anchor's global: namespace", () => {
  // Wrong prefix = 8 bytes matching no instruction = opaque on-chain rejection.
  assert.notDeepEqual(discriminator("issue"), discriminator("global:issue"));
  assert.equal(discriminator("issue").length, 8);
});

test("issue encodes to the documented byte layout", () => {
  const ix = issueIx({
    programId: PROGRAM,
    issuer: ISSUER,
    subjectHash: SUBJECT,
    score: 64,
    method: METHOD.OWNERSHIP_PROVEN | METHOD.CORROBORATED,
    ttlSeconds: 7776000,
  });

  assert.equal(ix.data.length, ISSUE_LAYOUT.total, "total encoded size");

  const { discriminator: d, subjectHash: sh, score, method, baseUid, ttlSeconds } = ISSUE_LAYOUT;

  assert.deepEqual(
    ix.data.subarray(d.offset, d.offset + d.size),
    discriminator("issue"),
  );
  assert.deepEqual(
    new Uint8Array(ix.data.subarray(sh.offset, sh.offset + sh.size)),
    SUBJECT,
  );
  assert.equal(ix.data[score.offset], 64);
  // 0b0110 — ownership proven + corroborated
  assert.equal(ix.data[method.offset], 6);
  assert.deepEqual(
    new Uint8Array(ix.data.subarray(baseUid.offset, baseUid.offset + baseUid.size)),
    NO_BASE_UID,
  );
  assert.equal(
    ix.data.readBigInt64LE(ttlSeconds.offset),
    7776000n,
    "i64 must be little-endian",
  );
});

test("issue account order matches the Rust Issue<'info> struct", () => {
  // Anchor matches accounts positionally. Wrong order = wrong account written.
  const ix = issueIx({
    programId: PROGRAM,
    issuer: ISSUER,
    subjectHash: SUBJECT,
    score: 1,
    method: METHOD.SELF_ASSERTED,
    ttlSeconds: 0,
  });
  const [pda] = attestationPda(PROGRAM, SUBJECT);

  assert.equal(ix.keys.length, 3);
  assert.ok(ix.keys[0].pubkey.equals(pda), "0: attestation PDA");
  assert.ok(ix.keys[1].pubkey.equals(ISSUER), "1: issuer");
  assert.ok(ix.keys[2].pubkey.equals(SystemProgram.programId), "2: system program");

  assert.equal(ix.keys[0].isWritable, true, "PDA is initialised, must be writable");
  assert.equal(ix.keys[1].isSigner, true, "issuer signs");
  assert.equal(ix.keys[1].isWritable, true, "issuer pays rent, must be writable");
});

test("revoke does not mark the issuer writable", () => {
  // revoke only flips a flag — the issuer pays no rent, so requesting write
  // access it does not need is a needless widening of the transaction.
  const ix = revokeIx(PROGRAM, ISSUER, SUBJECT);
  assert.equal(ix.keys.length, 2);
  assert.equal(ix.keys[1].isSigner, true);
  assert.equal(ix.keys[1].isWritable, false);
  assert.equal(ix.data.length, 8 + 32);
});

test("link_base carries both the subject and the uid", () => {
  const uid = new Uint8Array(32).fill(0xab);
  const ix = linkBaseIx(PROGRAM, ISSUER, SUBJECT, uid);
  assert.equal(ix.data.length, 8 + 32 + 32);
  assert.deepEqual(new Uint8Array(ix.data.subarray(40, 72)), uid);
});

// ---------------------------------------------------------------------------
// Guards that stop a bad transaction being paid for
// ---------------------------------------------------------------------------

test("score above 100 is rejected client-side", () => {
  assert.throws(
    () =>
      issueIx({
        programId: PROGRAM,
        issuer: ISSUER,
        subjectHash: SUBJECT,
        score: 101,
        method: 0,
        ttlSeconds: 0,
      }),
    /score must be 0\.\.100/,
  );
});

test("a wrong-length subject hash is rejected", () => {
  assert.throws(
    () =>
      issueIx({
        programId: PROGRAM,
        issuer: ISSUER,
        subjectHash: new Uint8Array(31),
        score: 1,
        method: 0,
        ttlSeconds: 0,
      }),
    /32 bytes/,
  );
});

// ---------------------------------------------------------------------------
// The PDA the client derives must be the one the program derives
// ---------------------------------------------------------------------------

test("derived PDA is stable for a given subject", async () => {
  const sh = await subjectHash("github", "alice");
  const [a] = attestationPda(PROGRAM, sh);
  const [b] = attestationPda(PROGRAM, sh);
  assert.ok(a.equals(b));

  const other = await subjectHash("x", "alice");
  const [c] = attestationPda(PROGRAM, other);
  assert.ok(!a.equals(c), "different namespace must derive a different account");
});
