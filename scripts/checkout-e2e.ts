/**
 * scripts/checkout-e2e.ts — the whole checkout, against a live validator.
 *
 *   npx tsx scripts/checkout-e2e.ts        (local validator running — see README)
 *
 * Drives the same functions the API routes and the admin script call, with a
 * keypair standing in for Phantom: the server builds the transaction, ONLY the
 * buyer signs it, and the chain decides. Then it checks the part the unit
 * tests cannot — that every way an order ends also deletes its address.
 *
 * Uses a throwaway quote secret, address key and store directory, so it never
 * touches .env.local's real ones or any stored address.
 */

import { readFileSync, mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
  PublicKey,
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
  const o = await import("../lib/chains/solana/orders");
  const spl = await import("../lib/chains/solana/spl");
  const { signQuote } = await import("../lib/checkout/quote");
  const { AddressStore } = await import("../lib/checkout/address-store");
  const { prepareCheckout, prepareRefund, readOrder, chainStatusReader } = await import("../lib/checkout/checkout");
  const { fulfilOrder, refundOrderAsOperator } = await import("../lib/checkout/operator");

  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  if (!(await conn.getAccountInfo(o.ORDERS_PROGRAM_ID))?.executable) {
    throw new Error("The orders program is not loaded — start the local validator first (README).");
  }

  const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.ISSUER_SECRET!)));
  const buyer = Keypair.generate(); // stands in for the shopper's Phantom wallet
  const stranger = Keypair.generate();

  // Throwaway secrets and store: nothing here touches real configuration.
  const storeDir = mkdtempSync(join(tmpdir(), "sigpath-e2e-"));
  const store = AddressStore.withKey(storeDir, randomBytes(32));
  const env: Record<string, string> = { QUOTE_SECRET: randomBytes(32).toString("hex"), EUR_USD_RATE: "1.1367" };
  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch; // deterministic: use the configured fallback rate

  const address = { name: "Ada Lovelace", line1: "Hauptstr. 1", postcode: "10115", city: "Berlin", country: "DE" };
  const quote = (amount: number, currency: string, id: string) =>
    signQuote({ source: "ebay", id, url: `https://www.ebay.de/itm/${id}`, title: `Item ${id}`, seller: "e2e_seller", amount, currency }, env)!;
  const bal = async (acct: PublicKey) => spl.tokenAmountFromData((await conn.getAccountInfo(acct))?.data) ?? 0n;

  /** What Phantom does: sign the server's transaction as the buyer, send it. */
  async function walletSignsAndSends(b64: string, signer: Keypair) {
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    tx.partialSign(signer);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  }

  // --- setup ---------------------------------------------------------------
  console.log("setup");
  for (const kp of [operator, buyer, stranger]) {
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  }
  const buyerAta = spl.associatedTokenAddress(buyer.publicKey, o.USDC_MINT);
  const operatorAta = spl.associatedTokenAddress(operator.publicKey, o.USDC_MINT);
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      spl.createAtaIdempotentIx(operator.publicKey, buyer.publicKey, o.USDC_MINT),
      spl.createAtaIdempotentIx(operator.publicKey, operator.publicKey, o.USDC_MINT),
      spl.mintToIx({ mint: o.USDC_MINT, destination: buyerAta, authority: operator.publicKey, amount: 500_000_000n }),
    ),
    [operator],
  );
  check("shopper wallet holds 500 test USDC", (await bal(buyerAta)) === 500_000_000n);

  // --- 1. pay, then fulfil ---------------------------------------------------
  console.log("\n1. checkout 249.00 EUR -> pay -> operator fulfils");
  {
    const r = await prepareCheckout(
      { quote: quote(24900, "EUR", "1"), buyer: buyer.publicKey.toBase58(), address },
      { env, conn, store, fetchImpl: offline },
    );
    if (!r.ok) throw new Error(`checkout failed: ${r.error}`);
    check("priced at 283.0383 USDC (249.00 EUR x 1.1367)", r.usdcBaseUnits === "283038300", r.usdcDisplay);
    check("address stored before the transaction was handed out", (await store.get(r.order)) !== null);

    const before = await bal(buyerAta);
    await walletSignsAndSends(r.transaction, buyer);
    const state = await readOrder(conn, new PublicKey(r.order));
    check("the chain accepted a transaction signed ONLY by the shopper", state.found && state.status === "funded");
    check("escrow holds exactly the quoted amount", state.found && state.amount === 283_038_300n);
    check("shopper debited exactly that", (await bal(buyerAta)) === before - 283_038_300n);

    const opBefore = await bal(operatorAta);
    const res = await fulfilOrder(conn, operator, new PublicKey(r.order), "EBAY-ORDER-11-22-33", store);
    check("fulfil deletes the address after it confirms", res.addressDeleted && (await store.get(r.order)) === null);
    check("operator paid from escrow", (await bal(operatorAta)) === opBefore + 283_038_300n);
    const after = await readOrder(conn, new PublicKey(r.order));
    check("order shows fulfilled on chain", after.found && after.status === "fulfilled");
  }

  // --- 2. pay, then operator refunds early --------------------------------------
  console.log("\n2. checkout 50.00 USD -> pay -> operator refunds (item unavailable)");
  {
    const r = await prepareCheckout(
      { quote: quote(5000, "USD", "2"), buyer: buyer.publicKey.toBase58(), address },
      { env, conn, store, fetchImpl: offline },
    );
    if (!r.ok) throw new Error(`checkout failed: ${r.error}`);
    check("USD needs no exchange rate", r.usdcBaseUnits === "50000000" && r.rate === null);
    const before = await bal(buyerAta);
    await walletSignsAndSends(r.transaction, buyer);
    const res = await refundOrderAsOperator(conn, operator, new PublicKey(r.order), store);
    check("operator refund deletes the address", res.addressDeleted && (await store.get(r.order)) === null);
    check("shopper made whole", (await bal(buyerAta)) === before);
  }

  // --- 3. checkout abandoned before paying -------------------------------------
  console.log("\n3. checkout started, never paid");
  {
    const r = await prepareCheckout(
      { quote: quote(1000, "EUR", "3"), buyer: buyer.publicKey.toBase58(), address },
      { env, conn, store, fetchImpl: offline },
    );
    if (!r.ok) throw new Error(`checkout failed: ${r.error}`);
    const soon = await store.sweep(chainStatusReader(conn));
    check("not deleted while the payment could still be confirming", soon.length === 0 && (await store.get(r.order)) !== null);
    const later = await store.sweep(chainStatusReader(conn), Date.now() + 16 * 60 * 1000);
    check("deleted once the pending window passes", later.some((d) => d.order === r.order && d.reason === "checkout abandoned"));
  }

  // --- 4. deadline passes, a stranger triggers the refund --------------------------
  console.log(`\n4. deadline passes (waiting ${o.MIN_WINDOW_SECS + 5}s), anyone refunds`);
  {
    const r = await prepareCheckout(
      { quote: quote(2000, "EUR", "4"), buyer: buyer.publicKey.toBase58(), address },
      { env: { ...env, CHECKOUT_WINDOW_SECS: String(o.MIN_WINDOW_SECS) }, conn, store, fetchImpl: offline },
    );
    if (!r.ok) throw new Error(`checkout failed: ${r.error}`);
    const before = await bal(buyerAta);
    await walletSignsAndSends(r.transaction, buyer);

    const early = await prepareRefund({ order: r.order, caller: stranger.publicKey.toBase58() }, { conn });
    check("no refund offered to a stranger before the deadline", !early.ok && early.status === 409);

    await new Promise((res) => setTimeout(res, (o.MIN_WINDOW_SECS + 5) * 1000));
    const late = await prepareRefund({ order: r.order, caller: stranger.publicKey.toBase58() }, { conn });
    check("refund transaction offered to anyone after the deadline", late.ok);
    if (late.ok) await walletSignsAndSends(late.transaction, stranger);
    check("shopper refunded to their own wallet, by a stranger's signature", (await bal(buyerAta)) === before);

    const swept = await store.sweep(chainStatusReader(conn));
    check("the sweep deletes a refunded order's address", swept.some((d) => d.order === r.order && d.reason === "order refunded"));
  }

  check("no addresses left behind", readdirSync(storeDir).length === 0);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("CHECKOUT BEHAVES AS SPECIFIED");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
