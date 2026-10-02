/**
 * scripts/sas-verified-roundtrip.ts — prove the verified-seller token, live.
 *
 *   npx tsx scripts/sas-verified-roundtrip.ts
 *
 * Registers and tokenizes the verified-seller schema (once per cluster), then
 * for a throwaway stub handle:
 *   - issues the badge to the devnet test wallet (.data/devnet-test-buyer.json)
 *   - reads it back from the handle alone: valid, held by that wallet
 *   - checks the mint is NonTransferable, and SIMULATES a transfer to another
 *     wallet, which must fail (simulation: free, nothing sent)
 *   - refuses a second badge for the same handle
 *   - revokes it: token burned, attestation closed, rent returned
 *
 * Devnet only. The handle is unique per run on the "stub" namespace.
 */

import { readFileSync, existsSync } from "fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

function loadEnv(path = ".env.local") {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (!line || line.startsWith("#") || eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}
loadEnv();
process.env.SAS_ENABLED = "true";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { sasConfigFromEnv, signer } = await import("../lib/chains/solana/sas");
  const V = await import("../lib/chains/solana/sas-verified");
  const { subjectHash } = await import("../lib/crypto/hash");

  const cfg = sasConfigFromEnv();
  if (!cfg || !/devnet/.test(cfg.rpcUrl)) throw new Error("SAS must be configured on devnet.");
  if (!existsSync(".data/devnet-test-buyer.json")) throw new Error("Run scripts/devnet-checkout.ts first to create the test wallet.");
  const holder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".data/devnet-test-buyer.json", "utf8"))));
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const authority = (await signer(cfg)).address;
  const before = await conn.getBalance(new PublicKey(authority));

  const handle = `sigpath-verified-demo-${Date.now()}`;
  const subject = await subjectHash("stub", handle);
  console.log(`issuer   ${authority}`);
  console.log(`seller   stub:${handle}`);
  console.log(`wallet   ${holder.publicKey.toBase58()}\n`);

  const boot = await V.bootstrapVerifiedSchema(cfg);
  if (boot.status === "error" || boot.status === "disabled") throw new Error(boot.reason);
  console.log(`schema   ${boot.status === "exists" ? "already tokenized" : `tokenized, tx ${boot.signature}`}\n`);

  // --- issue -------------------------------------------------------------------
  const issued = await V.issueVerifiedBadge(cfg, {
    sellerSubject: subject,
    wallet: holder.publicKey.toBase58(),
    verifiedAt: Math.floor(Date.now() / 1000),
    uri: `https://sigpath.example/seller/stub/${handle}`,
  });
  if (issued.status !== "ok") throw new Error(issued.reason);
  console.log(`issued   ${issued.explorer}`);
  console.log(`token    https://explorer.solana.com/address/${issued.mint}?cluster=devnet`);

  await pause(1500);
  const read = await V.readVerifiedSeller(authority, subject, cfg.rpcUrl);
  check("read back from the handle alone: valid, held by the seller's wallet", read.status === "valid" && read.holder === holder.publicKey.toBase58());

  // --- soulbound -----------------------------------------------------------------
  const mintInfo = await conn.getAccountInfo(new PublicKey(issued.mint));
  // Token-2022 mint extensions are TLV entries after byte 166; NonTransferable is type 9.
  const tlvTypes: number[] = [];
  if (mintInfo) {
    for (let off = 166; off + 4 <= mintInfo.data.length; ) {
      const type = mintInfo.data.readUInt16LE(off);
      const len = mintInfo.data.readUInt16LE(off + 2);
      if (type === 0) break;
      tlvTypes.push(type);
      off += 4 + len;
    }
  }
  check("the mint carries NonTransferable and a PermanentDelegate", tlvTypes.includes(9) && tlvTypes.includes(12), `extensions ${tlvTypes.join(",")}`);

  const elsewhere = Keypair.generate().publicKey;
  const TOKEN_2022 = new PublicKey(V.TOKEN_2022_PROGRAM);
  const ATA = new PublicKey(V.ATA_PROGRAM);
  const mint = new PublicKey(issued.mint);
  const destAta = PublicKey.findProgramAddressSync([elsewhere.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ATA)[0];
  const createDest = new TransactionInstruction({
    programId: ATA,
    keys: [
      { pubkey: holder.publicKey, isSigner: true, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: elsewhere, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // TransferChecked
  data.writeBigUInt64LE(1n, 1);
  data.writeUInt8(0, 9);
  const transfer = new TransactionInstruction({
    programId: TOKEN_2022,
    keys: [
      { pubkey: new PublicKey(issued.tokenAccount), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: holder.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(createDest, transfer);
  tx.feePayer = holder.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(holder);
  const sim = await conn.simulateTransaction(tx);
  // Token-2022's TokenError 37 is NonTransferable ("Transfer is disabled for
  // this mint"). It must come from instruction 1, the transfer itself — the
  // account creation before it has to succeed, or this would pass for the
  // wrong reason.
  const err = sim.value.err as { InstructionError?: [number, { Custom?: number }] } | null;
  check(
    "the holder CANNOT transfer it to another wallet (simulated, nothing sent)",
    err?.InstructionError?.[0] === 1 && err.InstructionError[1]?.Custom === 37,
    `Token-2022 error ${JSON.stringify(err)}: 37 = NonTransferable`,
  );

  // --- one per handle ------------------------------------------------------------
  const second = await V.issueVerifiedBadge(cfg, {
    sellerSubject: subject,
    wallet: elsewhere.toBase58(),
    verifiedAt: Math.floor(Date.now() / 1000),
    uri: `https://sigpath.example/seller/stub/${handle}`,
  });
  check("a second badge for the same handle is refused", second.status === "error", second.status === "error" ? second.reason.slice(0, 80) : "");

  // --- revoke --------------------------------------------------------------------
  const revoked = await V.revokeVerifiedBadge(cfg, subject);
  if (revoked.status !== "ok") throw new Error(`revoke: ${"reason" in revoked ? revoked.reason : revoked.status}`);
  console.log(`revoked  https://explorer.solana.com/tx/${revoked.signature}?cluster=devnet`);
  await pause(1500);
  check("after revocation, the handle reads as unverified", (await V.readVerifiedSeller(authority, subject, cfg.rpcUrl)).status === "none");
  check("the token is gone from the seller's wallet", (await conn.getTokenAccountBalance(new PublicKey(issued.tokenAccount)).catch(() => null))?.value.amount !== "1");

  // Cleanup: the holder closes its now-empty token account (Token-2022
  // CloseAccount, 9), so that rent isn't left stranded either.
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      new TransactionInstruction({
        programId: TOKEN_2022,
        keys: [
          { pubkey: new PublicKey(issued.tokenAccount), isSigner: false, isWritable: true },
          { pubkey: holder.publicKey, isSigner: false, isWritable: true },
          { pubkey: holder.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([9]),
      }),
    ),
    [holder],
    { commitment: "confirmed" },
  );

  const after = await conn.getBalance(new PublicKey(authority));
  console.log(`\nissuer SOL spent on this run: ${((before - after) / 1e9).toFixed(6)} (mint and attestation rent came back on revocation)`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("VERIFIED-SELLER TOKEN: ISSUED, SOULBOUND, ONE PER HANDLE, REVOCABLE");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
