/**
 * scripts/devnet-roundtrip.ts — the only thing that actually proves the encoding
 * is correct.
 *
 * There is no IDL, so nothing checks lib/chains/solana/instructions.ts against
 * programs/sigpath/src/lib.rs. The unit tests assert the encoder matches a layout
 * *we wrote down* — which is worthless if what we wrote down is wrong. This sends
 * a real transaction and reads the account back, so the program itself is the
 * judge.
 *
 * Run it after ANY change to the Rust account struct or instruction signature:
 *   npx tsx scripts/devnet-roundtrip.ts
 *
 * Costs a few thousand lamports of rent for one attestation PDA. Run it against
 * localnet instead if you are iterating:
 *   NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899 npx tsx scripts/devnet-roundtrip.ts
 */

import { readFileSync } from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// --- minimal .env.local loader ------------------------------------------------
// A standalone tsx script does not get Next.js's env loading, and pulling in
// dotenv for one script is not worth a dependency.
function loadEnv(path = ".env.local") {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read ${path}. Copy .env.local.example first.`);
    process.exit(1);
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

function issuerKeypair(): Keypair {
  const raw = process.env.ISSUER_SECRET;
  if (!raw) {
    console.error("ISSUER_SECRET is not set in .env.local.");
    process.exit(1);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function main() {
  // Imported here, not at the top: lib/config.ts reads process.env at module
  // load, so loadEnv() must have run first.
  const { issueIx, revokeIx, METHOD } = await import("../lib/chains/solana/instructions");
  const { verifySubject, describeMethods } = await import("../lib/chains/solana/client");
  const { subjectHash, bytesToHex } = await import("../lib/crypto/hash");

  const rpc = process.env.NEXT_PUBLIC_RPC_URL!;
  const programId = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID!);
  const conn = new Connection(rpc, "confirmed");
  const issuer = issuerKeypair();

  console.log(`rpc      ${rpc}`);
  console.log(`program  ${programId.toBase58()}`);
  console.log(`issuer   ${issuer.publicKey.toBase58()}`);
  console.log(`balance  ${(await conn.getBalance(issuer.publicKey)) / 1e9} SOL\n`);

  // Unique subject per run so repeat runs do not collide on an existing PDA.
  const handle = `roundtrip-${Date.now()}`;
  const subject = await subjectHash("github", handle);
  console.log(`subject  github:${handle}`);
  console.log(`hash     ${bytesToHex(subject)}\n`);

  // --- write -----------------------------------------------------------------
  const score = 64;
  const method = METHOD.OWNERSHIP_PROVEN | METHOD.CORROBORATED;
  const ttl = 7776000;

  const ix = issueIx({
    programId,
    issuer: issuer.publicKey,
    subjectHash: subject,
    score,
    method,
    ttlSeconds: ttl,
  });

  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [issuer], {
    commitment: "confirmed",
  });
  console.log(`issued   ${sig}`);

  // --- read back -------------------------------------------------------------
  const result = await verifySubject(subject, conn);
  if (result.status !== "verified") {
    console.error(`FAIL: expected verified, got ${result.status}`);
    process.exit(1);
  }

  const a = result.attestation;
  const checks: Array<[string, unknown, unknown]> = [
    ["subjectHash", a.subjectHash, bytesToHex(subject)],
    ["issuer", a.issuer, issuer.publicKey.toBase58()],
    ["score", a.score, score],
    ["method", a.method, method],
    ["baseUid", a.baseUid, null],
    ["expiresAt set", a.expiresAt !== null, true],
    ["revoked", a.revoked, false],
  ];

  let failed = false;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    if (!ok) failed = true;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: got ${got}, want ${want}`);
  }

  // expires_at must be issued_at + ttl, computed from the on-chain Clock.
  const drift = a.expiresAt! - a.issuedAt - ttl;
  const ttlOk = drift === 0;
  if (!ttlOk) failed = true;
  console.log(`  ${ttlOk ? "ok  " : "FAIL"} expiresAt = issuedAt + ttl (drift ${drift}s)`);

  console.log(`\nmethods: ${describeMethods(a).join(", ")}`);

  // --- revoke, and confirm the state actually changes -------------------------
  const revokeSig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(revokeIx(programId, issuer.publicKey, subject)),
    [issuer],
    { commitment: "confirmed" },
  );
  console.log(`\nrevoked  ${revokeSig}`);

  const after = await verifySubject(subject, conn);
  const revokedOk = after.status === "revoked";
  if (!revokedOk) failed = true;
  console.log(`  ${revokedOk ? "ok  " : "FAIL"} status after revoke: ${after.status}`);

  console.log(failed ? "\nROUND-TRIP FAILED" : "\nROUND-TRIP PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\nERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
