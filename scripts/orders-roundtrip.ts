/**
 * scripts/orders-roundtrip.ts — prove the escrow against a live validator.
 *
 *   # write USDC and EURC mint accounts (at the real devnet addresses, with
 *   # the operator as mint authority) for the local validator to load:
 *   npx tsx scripts/orders-roundtrip.ts --write-mint ./usdc-mint.json --write-eurc-mint ./eurc-mint.json
 *
 *   # then, with solana-test-validator running (see README):
 *   npx tsx scripts/orders-roundtrip.ts --local
 *
 * Every scenario asserts an outcome, including the ones that are SUPPOSED to
 * fail. A test that only walks the happy path would pass against an escrow that
 * paid anyone who asked; the attacks are the point.
 *
 * Local mode mints test USDC and EURC freely, which only works because the
 * local mint accounts were written with the operator as mint authority.
 * Nothing here can mint on devnet.
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

  // --- mode 1: write the local mint accounts --------------------------------
  const writeMint = (mint: PublicKey, name: string, out: string) => {
    // SPL Mint, 82 bytes: mint_authority COption<Pubkey> (4+32) | supply u64
    // | decimals u8 | is_initialized u8 | freeze_authority COption<Pubkey> (4+32)
    const data = Buffer.alloc(82);
    data.writeUInt32LE(1, 0);
    operator.publicKey.toBuffer().copy(data, 4);
    data.writeBigUInt64LE(0n, 36);
    data.writeUInt8(o.TOKEN_DECIMALS, 44);
    data.writeUInt8(1, 45);
    data.writeUInt32LE(0, 46);
    writeFileSync(
      out,
      JSON.stringify({
        pubkey: mint.toBase58(),
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
    console.log(`wrote local ${name} mint (authority ${operator.publicKey.toBase58()}) to ${out}`);
  };
  const wi = args.indexOf("--write-mint");
  const we = args.indexOf("--write-eurc-mint");
  if (wi !== -1 || we !== -1) {
    if (wi !== -1) {
      if (!args[wi + 1]) throw new Error("--write-mint needs a path");
      writeMint(o.USDC_MINT, "USDC", args[wi + 1]);
    }
    if (we !== -1) {
      if (!args[we + 1]) throw new Error("--write-eurc-mint needs a path");
      writeMint(o.EURC_MINT, "EURC", args[we + 1]);
    }
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
  const USDC = o.USDC_MINT;

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
      [o.createOrderIx({ buyer: buyer.publicKey, nonce: n, amount: 5_000_000n, listingHash: listing, windowSecs: 3600, mint: USDC })],
      [buyer],
    );
    const vault = o.vaultPda(order)[0];
    check("vault holds exactly the order amount", (await bal(vault)) === 5_000_000n);
    check("buyer debited 5 USDC", (await bal(buyerAta)) === buyerBefore - 5_000_000n);
    const created = await orderState(order);
    check("order recorded as funded, for this listing", created.status === "funded" && created.listingHash.equals(listing));
    check("order records its coin: USDC", created.token === "USDC");

    await expectError(
      "a non-operator cannot fulfil (and so cannot be paid)",
      "NotOperator",
      [o.fulfilIx({ order, buyer: buyer.publicKey, fulfilmentRef: o.fulfilmentRefHash("x"), mint: USDC, operator: stranger.publicKey, operatorToken: strangerAta })],
      [stranger],
    );
    await expectError(
      "a stranger cannot refund before the deadline",
      "DeadlineNotReached",
      [o.refundIx({ caller: stranger.publicKey, order, buyer: buyer.publicKey, mint: USDC })],
      [stranger],
    );

    await send(
      [o.fulfilIx({ order, buyer: buyer.publicKey, fulfilmentRef: o.fulfilmentRefHash("AMZ-302-1234567"), mint: USDC })],
      [operator],
    );
    const done = await orderState(order);
    check("order fulfilled with the reference committed", done.status === "fulfilled" && done.fulfilmentRef.equals(o.fulfilmentRefHash("AMZ-302-1234567")));
    check("operator paid exactly 5 USDC", (await bal(operatorAta)) === opBefore + 5_000_000n);
    check("vault closed, rent returned", (await conn.getAccountInfo(vault)) === null);
    await expectError(
      "a fulfilled order cannot also be refunded",
      "NotFunded",
      [o.refundIx({ caller: operator.publicKey, order, buyer: buyer.publicKey, mint: USDC })],
      [operator],
    );
  }

  // --- B. operator refunds early (item unavailable) -------------------------
  console.log("\nB. operator refunds early");
  {
    const { nonce: n, order } = nextOrder();
    const before = await bal(buyerAta);
    await send(
      [o.createOrderIx({ buyer: buyer.publicKey, nonce: n, amount: 3_000_000n, listingHash: listing, windowSecs: 3600, mint: USDC })],
      [buyer],
    );
    await send([o.refundIx({ caller: operator.publicKey, order, buyer: buyer.publicKey, mint: USDC })], [operator]);
    check("buyer made whole", (await bal(buyerAta)) === before);
    check("order marked refunded", (await orderState(order)).status === "refunded");
  }

  // --- C. the deadline passes ------------------------------------------------
  console.log(`\nC. deadline passes (waiting ${o.MIN_WINDOW_SECS + 5}s for a real on-chain deadline)`);
  {
    const { nonce: n, order } = nextOrder();
    const before = await bal(buyerAta);
    await send(
      [o.createOrderIx({ buyer: buyer.publicKey, nonce: n, amount: 7_000_000n, listingHash: listing, windowSecs: o.MIN_WINDOW_SECS, mint: USDC })],
      [buyer],
    );
    const vault = o.vaultPda(order)[0];
    await new Promise((r) => setTimeout(r, (o.MIN_WINDOW_SECS + 5) * 1000));

    await expectError(
      "the operator cannot fulfil late and race the refund",
      "DeadlinePassed",
      [o.fulfilIx({ order, buyer: buyer.publicKey, fulfilmentRef: o.fulfilmentRefHash("late"), mint: USDC })],
      [operator],
    );
    await expectError(
      "a stranger cannot redirect the refund to their own account",
      "RefundNotToBuyer",
      [o.refundIx({ caller: stranger.publicKey, order, buyer: buyer.publicKey, mint: USDC, buyerToken: strangerAta })],
      [stranger],
    );

    // Grief attempt: a stray unit in the vault would make CloseAccount fail.
    await send(
      [spl.transferCheckedIx({ source: strangerAta, mint: o.USDC_MINT, destination: vault, owner: stranger.publicKey, amount: 1n, decimals: o.USDC_DECIMALS })],
      [stranger],
    );
    check("grief: an extra unit landed in the vault", (await bal(vault)) === 7_000_001n);

    // Anyone may now trigger the refund; it can only go to the buyer.
    await send([o.refundIx({ caller: stranger.publicKey, order, buyer: buyer.publicKey, mint: USDC })], [stranger]);
    check("a stranger CAN trigger the refund once the deadline passes", (await orderState(order)).status === "refunded");
    check("buyer made whole, the stray unit included", (await bal(buyerAta)) === before + 1n);
    check("vault closed despite the grief attempt", (await conn.getAccountInfo(vault)) === null);
    await expectError(
      "a refunded order cannot be refunded twice",
      "NotFunded",
      [o.refundIx({ caller: stranger.publicKey, order, buyer: buyer.publicKey, mint: USDC })],
      [stranger],
    );
  }

  // --- D. an order paid in EURC ------------------------------------------------
  console.log("\nD. paid in EURC: the coin is kept straight end to end");
  {
    const EURC = o.EURC_MINT;
    const buyerEurc = spl.associatedTokenAddress(buyer.publicKey, EURC);
    const operatorEurc = spl.associatedTokenAddress(operator.publicKey, EURC);
    await send(
      [
        spl.createAtaIdempotentIx(operator.publicKey, buyer.publicKey, EURC),
        spl.createAtaIdempotentIx(operator.publicKey, operator.publicKey, EURC),
        spl.mintToIx({ mint: EURC, destination: buyerEurc, authority: operator.publicKey, amount: 50_000_000n }),
      ],
      [operator],
    );
    check("buyer funded with 50 test EURC", (await bal(buyerEurc)) === 50_000_000n);

    // Fulfilled in EURC.
    const a = nextOrder();
    const usdcBefore = await bal(buyerAta);
    await send([o.createOrderIx({ buyer: buyer.publicKey, nonce: a.nonce, amount: 15_000_000n, listingHash: listing, windowSecs: 3600, mint: EURC })], [buyer]);
    check("EURC order: buyer debited 15 EURC, no USDC touched", (await bal(buyerEurc)) === 35_000_000n && (await bal(buyerAta)) === usdcBefore);
    const info = await conn.getAccountInfo(a.order);
    check("the order account is the longer one, with the coin after the record", info?.data.length === o.ORDER_LAYOUT.sizeWithMint);
    check("the order records its coin: EURC", (await orderState(a.order)).token === "EURC");
    await expectError(
      "the operator cannot take an EURC order's money as USDC",
      "code 3", // the token program's MintMismatch
      [o.fulfilIx({ order: a.order, buyer: buyer.publicKey, fulfilmentRef: o.fulfilmentRefHash("EUR-1"), mint: USDC })],
      [operator],
    );
    const opEurcBefore = await bal(operatorEurc);
    await send([o.fulfilIx({ order: a.order, buyer: buyer.publicKey, fulfilmentRef: o.fulfilmentRefHash("EUR-1"), mint: EURC })], [operator]);
    check("operator paid exactly 15 EURC", (await bal(operatorEurc)) === opEurcBefore + 15_000_000n);
    check("the order still says EURC after the vault closed", (await orderState(a.order)).token === "EURC");

    // Refunded in EURC, and only in EURC.
    const b = nextOrder();
    await send([o.createOrderIx({ buyer: buyer.publicKey, nonce: b.nonce, amount: 10_000_000n, listingHash: listing, windowSecs: 3600, mint: EURC })], [buyer]);
    await expectError(
      "an EURC refund cannot be sent to the buyer's USDC account",
      "WrongMint",
      [o.refundIx({ caller: operator.publicKey, order: b.order, buyer: buyer.publicKey, mint: USDC })],
      [operator],
    );
    await send([o.refundIx({ caller: operator.publicKey, order: b.order, buyer: buyer.publicKey, mint: EURC })], [operator]);
    check("buyer made whole in EURC", (await bal(buyerEurc)) === 35_000_000n);

    // Any other coin is refused at the door.
    const c = nextOrder();
    const fakeMint = Keypair.generate().publicKey;
    await expectError(
      "an order in any other coin is refused",
      "WrongMint",
      [o.createOrderIx({ buyer: buyer.publicKey, nonce: c.nonce, amount: 1_000_000n, listingHash: listing, windowSecs: 3600, mint: fakeMint, buyerToken: buyerAta })],
      [buyer],
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
