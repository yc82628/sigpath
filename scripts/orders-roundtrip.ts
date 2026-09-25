/**
 * scripts/orders-roundtrip.ts — prove the escrow against a live validator.
 *
 *   # write a USDC mint account (at the real devnet USDC address, with the
 *   # operator as mint authority) for the local validator to load:
 *   npx tsx scripts/orders-roundtrip.ts --write-mint ./usdc-mint.json
 *
 *   # then, with solana-test-validator running (see README):
 *   npx tsx scripts/orders-roundtrip.ts --local
 *
 * Every scenario asserts an outcome, including the ones that are SUPPOSED to
 * fail. A test that only walks the happy path would pass against an escrow that
 * paid anyone who asked; the attacks are the point.
 *
 * Local mode mints test USDC freely, which only works because the local mint
 * account was written with the operator as mint authority. Nothing here can
 * mint on devnet.
 */

import { readFileSync, writeFileSync } from "fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

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

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

async function main() {
  const args = process.argv.slice(2);
  const o = await import("../lib/chains/solana/orders");
  const spl = await import("../lib/chains/solana/spl");

  const secret = process.env.ISSUER_SECRET;
  if (!secret) throw new Error("ISSUER_SECRET (the operator key) is not set in .env.local.");
  const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  if (!operator.publicKey.equals(o.OPERATOR)) {
    throw new Error(`ISSUER_SECRET is ${operator.publicKey.toBase58()}, but the program's OPERATOR is ${o.OPERATOR.toBase58()}.`);
  }

  // --- mode 1: write the local mint account ---------------------------------
  const wi = args.indexOf("--write-mint");
  if (wi !== -1) {
    const out = args[wi + 1];
    if (!out) throw new Error("--write-mint needs a path");
    // SPL Mint, 82 bytes: mint_authority COption<Pubkey> (4+32) | supply u64
    // | decimals u8 | is_initialized u8 | freeze_authority COption<Pubkey> (4+32)
    const data = Buffer.alloc(82);
    data.writeUInt32LE(1, 0);
    operator.publicKey.toBuffer().copy(data, 4);
    data.writeBigUInt64LE(0n, 36);
    data.writeUInt8(o.USDC_DECIMALS, 44);
    data.writeUInt8(1, 45);
    data.writeUInt32LE(0, 46);
    writeFileSync(
      out,
      JSON.stringify({
        pubkey: o.USDC_MINT.toBase58(),
        account: {
          lamports: 1_461_600,
          data: [data.toString("base64"), "base64"],
          owner: spl.TOKEN_PROGRAM_ID.toBase58(),
          executable: false,
          rentEpoch: 0,
          space: 82,
        },
      }),
    );
    console.log(`wrote local USDC mint (authority ${operator.publicKey.toBase58()}) to ${out}`);
    return;
  }

  // --- mode 2: run the scenarios ---------------------------------------------
  const local = args.includes("--local");
  const ri = args.indexOf("--rpc");
  const rpc = ri !== -1 ? args[ri + 1] : local ? "http://127.0.0.1:8899" : process.env.NEXT_PUBLIC_RPC_URL!;
  if (!local) throw new Error("Only --local is implemented: devnet needs faucet USDC, see README.");

  const conn = new Connection(rpc, "confirmed");
  console.log(`rpc       ${rpc}`);
  console.log(`program   ${o.ORDERS_PROGRAM_ID.toBase58()}`);
  console.log(`operator  ${operator.publicKey.toBase58()}\n`);

  const programInfo = await conn.getAccountInfo(o.ORDERS_PROGRAM_ID);
  if (!programInfo?.executable) throw new Error("The orders program is not loaded on this validator.");

  const buyer = Keypair.generate();
  const stranger = Keypair.generate();

  const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
    sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

  /** Expect a failure with a specific program error name. */
  async function expectError(label: string, want: string, ixs: TransactionInstruction[], signers: Keypair[]) {
    try {
      await send(ixs, signers);
      check(label, false, "succeeded but should have failed");
    } catch (err) {
      const got = o.ordersErrorName(err);
      check(label, got === want, `got ${got ?? (err instanceof Error ? err.message.slice(0, 120) : err)}`);
    }
  }

  const bal = async (acct: PublicKey) => spl.tokenAmountFromData((await conn.getAccountInfo(acct))?.data) ?? 0n;
  const orderState = async (order: PublicKey) => o.decodeOrder((await conn.getAccountInfo(order))!.data);

  // --- setup -------------------------------------------------------------------
  console.log("setup");
  for (const kp of [operator, buyer, stranger]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }
  const buyerAta = spl.associatedTokenAddress(buyer.publicKey, o.USDC_MINT);
  const strangerAta = spl.associatedTokenAddress(stranger.publicKey, o.USDC_MINT);
  const operatorAta = spl.associatedTokenAddress(operator.publicKey, o.USDC_MINT);
  await send(
    [
      spl.createAtaIdempotentIx(operator.publicKey, buyer.publicKey, o.USDC_MINT),
      spl.createAtaIdempotentIx(operator.publicKey, stranger.publicKey, o.USDC_MINT),
      spl.createAtaIdempotentIx(operator.publicKey, operator.publicKey, o.USDC_MINT),
      spl.mintToIx({ mint: o.USDC_MINT, destination: buyerAta, authority: operator.publicKey, amount: 100_000_000n }),
      spl.mintToIx({ mint: o.USDC_MINT, destination: strangerAta, authority: operator.publicKey, amount: 1_000_000n }),
    ],
    [operator],
  );
  check("buyer funded with 100 test USDC", (await bal(buyerAta)) === 100_000_000n);

  const listing = o.listingHash({ source: "ebay", id: "v1|123|0", url: "https://www.ebay.de/itm/123" });
  let nonce = BigInt(Date.now());
  const nextOrder = () => {
    nonce += 1n;
    return { nonce, order: o.orderPda(buyer.publicKey, nonce)[0] };
  };

  // --- A. happy path --------------------------------------------------------
  console.log("\nA. create -> fulfil");
  {
    const { nonce: n, order } = nextOrder();
    const buyerBefore = await bal(buyerAta);
    const opBefore = await bal(operatorAta);
    await send(
      [o.createOrderIx({ buyer: buyer.publicKey, nonce: n, amount: 5_000_000n, listingHash: listing, windowSecs: 3600 })],
      [buyer],
    );
    const vault = o.vaultPda(order)[0];
    check("vault holds exactly the order amount", (await bal(vault)) === 5_000_000n);
    check("buyer debited 5 USDC", (await bal(buyerAta)) === buyerBefore - 5_000_000n);
    const created = await orderState(order);
    check("order recorded as funded, for this listing", created.status === "funded" && created.listingHash.equals(listing));

    await expectError(
      "a non-operator cannot fulfil (and so cannot be paid)",
      "NotOperator",
      [o.fulfilIx({ order, buyer: buyer.publicKey, fulfilmentRef: o.fulfilmentRefHash("x"), operator: stranger.publicKey, operatorToken: strangerAta })],
      [stranger],
    );
    await expectError(
      "a stranger cannot refund before the deadline",
      "DeadlineNotReached",
      [o.refundIx({ caller: stranger.publicKey, order, buyer: buyer.publicKey })],
      [stranger],
    );

    await send(
      [o.fulfilIx({ order, buyer: buyer.publicKey, fulfilmentRef: o.fulfilmentRefHash("AMZ-302-1234567") })],
      [operator],
    );
    const done = await orderState(order);
    check("order fulfilled with the reference committed", done.status === "fulfilled" && done.fulfilmentRef.equals(o.fulfilmentRefHash("AMZ-302-1234567")));
    check("operator paid exactly 5 USDC", (await bal(operatorAta)) === opBefore + 5_000_000n);
    check("vault closed, rent returned", (await conn.getAccountInfo(vault)) === null);
    await expectError(
      "a fulfilled order cannot also be refunded",
      "NotFunded",
      [o.refundIx({ caller: operator.publicKey, order, buyer: buyer.publicKey })],
      [operator],
    );
  }

  // --- B. operator refunds early (item unavailable) -------------------------
  console.log("\nB. operator refunds early");
  {
    const { nonce: n, order } = nextOrder();
    const before = await bal(buyerAta);
    await send(
      [o.createOrderIx({ buyer: buyer.publicKey, nonce: n, amount: 3_000_000n, listingHash: listing, windowSecs: 3600 })],
      [buyer],
    );
    await send([o.refundIx({ caller: operator.publicKey, order, buyer: buyer.publicKey })], [operator]);
    check("buyer made whole", (await bal(buyerAta)) === before);
    check("order marked refunded", (await orderState(order)).status === "refunded");
  }

  // --- C. the deadline passes ------------------------------------------------
  console.log(`\nC. deadline passes (waiting ${o.MIN_WINDOW_SECS + 5}s for a real on-chain deadline)`);
  {
    const { nonce: n, order } = nextOrder();
    const before = await bal(buyerAta);
    await send(
      [o.createOrderIx({ buyer: buyer.publicKey, nonce: n, amount: 7_000_000n, listingHash: listing, windowSecs: o.MIN_WINDOW_SECS })],
      [buyer],
    );
    const vault = o.vaultPda(order)[0];
    await new Promise((r) => setTimeout(r, (o.MIN_WINDOW_SECS + 5) * 1000));

    await expectError(
      "the operator cannot fulfil late and race the refund",
      "DeadlinePassed",
      [o.fulfilIx({ order, buyer: buyer.publicKey, fulfilmentRef: o.fulfilmentRefHash("late") })],
      [operator],
    );
    await expectError(
      "a stranger cannot redirect the refund to their own account",
      "RefundNotToBuyer",
      [o.refundIx({ caller: stranger.publicKey, order, buyer: buyer.publicKey, buyerToken: strangerAta })],
      [stranger],
    );

    // Grief attempt: a stray unit in the vault would make CloseAccount fail.
    await send(
      [spl.transferCheckedIx({ source: strangerAta, mint: o.USDC_MINT, destination: vault, owner: stranger.publicKey, amount: 1n, decimals: o.USDC_DECIMALS })],
      [stranger],
    );
    check("grief: an extra unit landed in the vault", (await bal(vault)) === 7_000_001n);

    // Anyone may now trigger the refund; it can only go to the buyer.
    await send([o.refundIx({ caller: stranger.publicKey, order, buyer: buyer.publicKey })], [stranger]);
    check("a stranger CAN trigger the refund once the deadline passes", (await orderState(order)).status === "refunded");
    check("buyer made whole, the stray unit included", (await bal(buyerAta)) === before + 1n);
    check("vault closed despite the grief attempt", (await conn.getAccountInfo(vault)) === null);
    await expectError(
      "a refunded order cannot be refunded twice",
      "NotFunded",
      [o.refundIx({ caller: stranger.publicKey, order, buyer: buyer.publicKey })],
      [stranger],
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("ESCROW BEHAVES AS SPECIFIED");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
