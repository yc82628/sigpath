/**
 * scripts/devnet-checkout.ts — the checkout against the DEPLOYED escrow on devnet.
 *
 *   npx tsx scripts/devnet-checkout.ts
 *
 * The same flow as checkout-e2e.ts, but on devnet with real Circle devnet USDC,
 * so it can't mint: a test buyer wallet (a keypair standing in for Phantom) has
 * to be given USDC first. The first run creates that wallet, saves it to
 * .data/devnet-test-buyer.json (gitignored) and prints its address for
 * faucet.circle.com (Solana Devnet). Rerun once the USDC has arrived.
 *
 * Kept deliberately cheap: orders of about 1 USDC, the buyer topped up to just
 * enough SOL for fees and rent, and the one-off "stranger" wallet's SOL sent
 * back to the operator at the end. The only SOL not returned is each order
 * account's rent, the buyer's on-chain receipt, about 0.002 SOL per order.
 *
 * Throwaway quote secret, address key and stores, as in checkout-e2e.ts:
 * nothing touches .env.local's real ones. The listing is on the "stub"
 * namespace, never a real marketplace seller.
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

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

const BUYER_FILE = ".data/devnet-test-buyer.json";
const RPC = process.env.ORDERS_RPC_URL?.trim() || "https://api.devnet.solana.com";
/** Enough for three checkouts: each needs >= 0.006 SOL on hand, and keeps ~0.002 as the order receipt. */
const BUYER_SOL_TARGET = 12_000_000;
/** A fresh system account must hold its rent-exempt minimum; the rest pays one fee. */
const STRANGER_SOL = 1_000_000;
/** Scenarios 1–3 need about 2.8 USDC at current rates; leave margin for the rate. */
const USDC_NEEDED = 3_500_000n;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public devnet RPC rate-limits bursts. Retry only on 429, never on a real error. */
async function retry429<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 5 || !/429|Too Many Requests/i.test(String(e))) throw e;
      await pause(3000 * (i + 1));
    }
  }
}

function loadOrCreateBuyer(): { kp: Keypair; created: boolean } {
  if (existsSync(BUYER_FILE)) {
    return { kp: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(BUYER_FILE, "utf8")))), created: false };
  }
  const kp = Keypair.generate();
  mkdirSync(".data", { recursive: true });
  writeFileSync(BUYER_FILE, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return { kp, created: true };
}

async function main() {
  const o = await import("../lib/chains/solana/orders");
  const spl = await import("../lib/chains/solana/spl");
  const { signQuote } = await import("../lib/checkout/quote");
  const { AddressStore } = await import("../lib/checkout/address-store");
  const { prepareCheckout, prepareRefund, readOrder, chainStatusReader } = await import("../lib/checkout/checkout");
  const { fulfilOrder, refundOrderAsOperator } = await import("../lib/checkout/operator");

  if (!/devnet/.test(RPC)) throw new Error(`Refusing to run against ${RPC}: devnet only.`);
  const conn = new Connection(RPC, "confirmed");
  if (!(await conn.getAccountInfo(o.ORDERS_PROGRAM_ID))?.executable) throw new Error("The orders program is not deployed on devnet.");

  const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.ISSUER_SECRET!)));
  const { kp: buyer, created } = loadOrCreateBuyer();
  const buyerAta = spl.associatedTokenAddress(buyer.publicKey, o.USDC_MINT);
  const operatorAta = spl.associatedTokenAddress(operator.publicKey, o.USDC_MINT);
  const bal = async (acct: PublicKey) => spl.tokenAmountFromData((await retry429(() => conn.getAccountInfo(acct)))?.data) ?? 0n;

  console.log(`rpc      ${RPC}`);
  console.log(`program  ${o.ORDERS_PROGRAM_ID.toBase58()}`);
  console.log(`buyer    ${buyer.publicKey.toBase58()}${created ? "  (new test wallet, saved to " + BUYER_FILE + ")" : ""}`);

  // --- USDC comes from Circle's faucet, which only a person can use ----------------
  const usdc = await bal(buyerAta);
  console.log(`         holds ${o.formatUsdc(usdc)}`);
  if (usdc < USDC_NEEDED) {
    console.log(`\nThe test buyer needs at least ${o.formatUsdc(USDC_NEEDED)}. Send it devnet USDC:`);
    console.log(`  1. open https://faucet.circle.com`);
    console.log(`  2. choose USDC and Solana Devnet`);
    console.log(`  3. paste ${buyer.publicKey.toBase58()}`);
    console.log(`then run this again.`);
    return;
  }

  // --- SOL: top up only to what the run needs ------------------------------------
  const startOperatorSol = await retry429(() => conn.getBalance(operator.publicKey));
  const buyerSol = await retry429(() => conn.getBalance(buyer.publicKey));
  const stranger = Keypair.generate();
  const fund = new Transaction();
  if (buyerSol < BUYER_SOL_TARGET) {
    fund.add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: buyer.publicKey, lamports: BUYER_SOL_TARGET - buyerSol }));
  }
  fund.add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: stranger.publicKey, lamports: STRANGER_SOL }));
  // The operator is paid into its USDC account; make sure it exists (no-op if it does).
  fund.add(spl.createAtaIdempotentIx(operator.publicKey, operator.publicKey, o.USDC_MINT));
  await retry429(() => sendAndConfirmTransaction(conn, fund, [operator], { commitment: "confirmed" }));
  console.log(`         topped up to ${(Math.max(buyerSol, BUYER_SOL_TARGET) / 1e9).toFixed(4)} SOL for fees and rent\n`);

  const storeDir = mkdtempSync(join(tmpdir(), "sigpath-devnet-"));
  const store = AddressStore.withKey(storeDir, randomBytes(32));
  const env: Record<string, string> = { QUOTE_SECRET: randomBytes(32).toString("hex"), EUR_USD_RATE: process.env.EUR_USD_RATE ?? "1.10" };
  const deps = { env, conn, store, metaStore: null, upheldReports: new Map<string, number>() };
  const address = { name: "Test Buyer", line1: "Teststr. 1", postcode: "10115", city: "Berlin", country: "DE" };
  const quote = (amount: number, currency: string, id: string) =>
    signQuote(
      { source: "stub", id, url: `https://example.invalid/devnet/${id}`, title: `Devnet test item ${id}`, seller: "sigpath-devnet-test", amount, currency },
      env,
    )!;
  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

  /** What Phantom does: sign the server's transaction as the buyer, send it. */
  async function walletSignsAndSends(b64: string, signer: Keypair) {
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    tx.partialSign(signer);
    const sig = await retry429(() => conn.sendRawTransaction(tx.serialize()));
    await retry429(() => conn.confirmTransaction(sig, "confirmed"));
    return sig;
  }

  // --- 1. pay, then fulfil --------------------------------------------------------
  console.log("1. checkout 1.00 EUR at the live ECB rate -> pay -> operator fulfils");
  {
    const r = await prepareCheckout({ quote: quote(100, "EUR", "1"), buyer: buyer.publicKey.toBase58(), address }, deps);
    if (!r.ok) throw new Error(`checkout failed: ${r.error}`);
    check("priced in USDC at the ECB rate", /^ECB/.test(r.rate?.source ?? "") && BigInt(r.usdcBaseUnits) > 1_000_000n, `${r.usdcDisplay} at ${r.rate?.display} — ${r.rate?.source}`);
    const amount = BigInt(r.usdcBaseUnits);
    const before = await bal(buyerAta);
    const sig = await walletSignsAndSends(r.transaction, buyer);
    console.log(`         paid     ${explorer(sig)}`);
    const state = await readOrder(conn, new PublicKey(r.order));
    check("the deployed program accepted a transaction signed only by the buyer", state.found && state.status === "funded");
    check("escrow holds exactly the quoted amount", state.found && state.amount === amount);
    check("buyer debited exactly that", (await bal(buyerAta)) === before - amount);

    const opBefore = await bal(operatorAta);
    const res = await retry429(() => fulfilOrder(conn, operator, new PublicKey(r.order), "DEVNET-TEST-FULFIL-1", store));
    console.log(`         fulfilled ${explorer(res.signature)}`);
    check("fulfil deletes the address after it confirms", res.addressDeleted && (await store.get(r.order)) === null);
    check("operator paid exactly the order amount from escrow", (await bal(operatorAta)) === opBefore + amount);
    const after = await readOrder(conn, new PublicKey(r.order));
    check("order shows fulfilled on chain", after.found && after.status === "fulfilled");
    console.log(`         order    https://explorer.solana.com/address/${r.order}?cluster=devnet`);
  }

  // --- 2. pay, then operator refunds early ----------------------------------------
  console.log("\n2. checkout 1.00 USD -> pay -> operator refunds (item unavailable)");
  {
    const r = await prepareCheckout({ quote: quote(100, "USD", "2"), buyer: buyer.publicKey.toBase58(), address }, deps);
    if (!r.ok) throw new Error(`checkout failed: ${r.error}`);
    check("USD needs no exchange rate", r.usdcBaseUnits === "1000000" && r.rate === null);
    const before = await bal(buyerAta);
    await walletSignsAndSends(r.transaction, buyer);
    const res = await retry429(() => refundOrderAsOperator(conn, operator, new PublicKey(r.order), store));
    console.log(`         refunded ${explorer(res.signature)}`);
    check("operator refund deletes the address", res.addressDeleted && (await store.get(r.order)) === null);
    check("buyer made whole", (await bal(buyerAta)) === before);
  }

  // --- 3. deadline passes, a stranger triggers the refund ---------------------------
  console.log(`\n3. 0.50 EUR, ${o.MIN_WINDOW_SECS}s window -> deadline passes (waiting ${o.MIN_WINDOW_SECS + 10}s) -> a stranger refunds`);
  {
    const r = await prepareCheckout(
      { quote: quote(50, "EUR", "3"), buyer: buyer.publicKey.toBase58(), address },
      { ...deps, env: { ...env, CHECKOUT_WINDOW_SECS: String(o.MIN_WINDOW_SECS) } },
    );
    if (!r.ok) throw new Error(`checkout failed: ${r.error}`);
    const before = await bal(buyerAta);
    await walletSignsAndSends(r.transaction, buyer);

    const early = await prepareRefund({ order: r.order, caller: stranger.publicKey.toBase58() }, { conn });
    check("no refund offered to a stranger before the deadline", !early.ok && early.status === 409);

    // Devnet's clock can trail wall time by a few seconds; wait a little past it.
    await pause((o.MIN_WINDOW_SECS + 10) * 1000);
    const late = await prepareRefund({ order: r.order, caller: stranger.publicKey.toBase58() }, { conn });
    check("refund transaction offered to anyone after the deadline", late.ok, late.ok ? "" : late.error);
    if (late.ok) console.log(`         refunded ${explorer(await walletSignsAndSends(late.transaction, stranger))}`);
    check("buyer refunded to their own wallet, by a stranger's signature", (await bal(buyerAta)) === before);
    const swept = await store.sweep(chainStatusReader(conn));
    check("the sweep deletes a refunded order's address", swept.some((d) => d.order === r.order && d.reason === "order refunded"));
  }

  check("no addresses left behind", readdirSync(storeDir).length === 0);

  // --- give back what the stranger didn't spend --------------------------------------
  const left = await retry429(() => conn.getBalance(stranger.publicKey));
  if (left > 5000) {
    await retry429(() =>
      sendAndConfirmTransaction(
        conn,
        new Transaction().add(SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: operator.publicKey, lamports: left - 5000 })),
        [stranger],
        { commitment: "confirmed" },
      ),
    );
  }
  const endOperatorSol = await retry429(() => conn.getBalance(operator.publicKey));
  console.log(`\noperator SOL spent on this run: ${((startOperatorSol - endOperatorSol) / 1e9).toFixed(6)} (buyer top-up + fees)`);
  console.log(`buyer now holds ${o.formatUsdc(await bal(buyerAta))}, ${((await retry429(() => conn.getBalance(buyer.publicKey))) / 1e9).toFixed(6)} SOL`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("CHECKOUT WORKS ON DEVNET, AGAINST THE DEPLOYED PROGRAM");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
