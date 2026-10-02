/**
 * scripts/devnet-report.ts — the fake-product report flow, on devnet, end to end.
 *
 *   npx tsx scripts/devnet-report.ts
 *
 * Uses the test buyer wallet from devnet-checkout.ts (.data/devnet-test-buyer.json,
 * which needs ~1 USDC; run that script first). Then, with the same functions
 * the API routes and reports-admin call:
 *
 *   1. buy a 0.50 EUR item through the deployed escrow; the operator fulfils
 *   2. the buyer reports it: only their wallet may, their signature is checked,
 *      the capture must belong to their signed session, a failed photo files nothing
 *   3. the seller's right of reply: no uphold before notice, none inside the
 *      window without a reply; the seller's link shows the report, not the
 *      buyer's photo or wallet; the seller replies
 *   4. upheld: published on chain through SAS, the buyer's evidence deleted
 *   5. the penalty: search flag, checkout refused, public finding with the
 *      seller's reply, readable on chain from the handle alone
 *   6. the seller appeals; the finding is reversed on chain, the penalty lifts,
 *      the finding stays listed as reversed
 *
 * WHAT IS STUBBED: the photo check. The real one asks the buyer to photograph
 * the item next to a freshly generated handwritten code, and checks it with the
 * vision model — a terminal can't take that photo. That check is covered by
 * its own tests and was proved live on the camera earlier; here a stub stands
 * in for its verdict, so everything AROUND it is real.
 *
 * The seller is "stub:sigpath-devnet-report-<timestamp>": unique per run and
 * on the stub namespace, so nothing is ever published about a real seller.
 * Throwaway stores, quote secret and address key — nothing touches .data's real
 * reports or .env.local's secrets. Devnet only.
 */

import { readFileSync, existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import nacl from "tweetnacl";
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
process.env.SAS_ENABLED = "true";

const BUYER_FILE = ".data/devnet-test-buyer.json";
const RPC = process.env.ORDERS_RPC_URL?.trim() || "https://api.devnet.solana.com";
/** One checkout to pay, and one more prepared (never sent) after the reversal: each needs >= 0.006 SOL on hand. */
const BUYER_SOL_TARGET = 10_000_000;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const is429 = (s: string) => /429|Too Many Requests/i.test(s);

async function retry429<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 5 || !is429(String(e))) throw e;
      await pause(3000 * (i + 1));
    }
  }
}

async function main() {
  const o = await import("../lib/chains/solana/orders");
  const spl = await import("../lib/chains/solana/spl");
  const { signQuote } = await import("../lib/checkout/quote");
  const { AddressStore } = await import("../lib/checkout/address-store");
  const { prepareCheckout, readOrder } = await import("../lib/checkout/checkout");
  const { fulfilOrder } = await import("../lib/checkout/operator");
  const { OrderMetaStore } = await import("../lib/reports/order-meta");
  const R = await import("../lib/reports/reports");
  const { CaseLog } = await import("../lib/reports/cases");
  const { signSellerToken, sellerLink } = await import("../lib/reports/seller-access");
  const { sellerFindings, publicFindings, respondAsSeller } = await import("../lib/reports/seller");
  const { reportPublisher, reversalPublisher } = await import("../lib/reports/publish");
  const { sasConfigFromEnv, signer } = await import("../lib/chains/solana/sas");
  const sasR = await import("../lib/chains/solana/sas-reports");
  const { subjectHash } = await import("../lib/crypto/hash");
  const { upheldReportFlags } = await import("../lib/marketplace/search");
  const { sellerKey } = await import("../lib/marketplace/types");

  if (!/devnet/.test(RPC)) throw new Error(`Refusing to run against ${RPC}: devnet only.`);
  const cfg = sasConfigFromEnv();
  if (!cfg || !/devnet/.test(cfg.rpcUrl)) throw new Error("SAS must be configured, on devnet (ISSUER_SECRET, NEXT_PUBLIC_RPC_URL).");
  if (!existsSync(BUYER_FILE)) throw new Error(`No test buyer yet — run scripts/devnet-checkout.ts first.`);

  const conn = new Connection(RPC, "confirmed");
  const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.ISSUER_SECRET!)));
  const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(BUYER_FILE, "utf8"))));
  const stranger = Keypair.generate(); // never funded: signing a message costs nothing
  const authority = (await signer(cfg)).address;
  const buyerAta = spl.associatedTokenAddress(buyer.publicKey, o.USDC_MINT);
  const usdc = spl.tokenAmountFromData((await retry429(() => conn.getAccountInfo(buyerAta)))?.data) ?? 0n;
  if (usdc < 1_000_000n) throw new Error(`The test buyer holds ${o.formatUsdc(usdc)}; it needs 1 USDC (faucet.circle.com).`);

  const seller = { source: "stub", handle: `sigpath-devnet-report-${Date.now()}` };
  const SELLER = sellerKey(seller.source, seller.handle);
  const subject = await subjectHash(seller.source, seller.handle);
  const startOperatorSol = await retry429(() => conn.getBalance(operator.publicKey));

  console.log(`program  ${o.ORDERS_PROGRAM_ID.toBase58()}`);
  console.log(`buyer    ${buyer.publicKey.toBase58()}  (${o.formatUsdc(usdc)})`);
  console.log(`seller   ${SELLER}  (test seller, unique to this run)\n`);

  const buyerSol = await retry429(() => conn.getBalance(buyer.publicKey));
  if (buyerSol < BUYER_SOL_TARGET) {
    await retry429(() =>
      sendAndConfirmTransaction(
        conn,
        new Transaction().add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: buyer.publicKey, lamports: BUYER_SOL_TARGET - buyerSol })),
        [operator],
        { commitment: "confirmed" },
      ),
    );
  }

  // Throwaway everything.
  const dir = mkdtempSync(join(tmpdir(), "sigpath-devnet-report-"));
  const key = randomBytes(32);
  const store = AddressStore.withKey(join(dir, "addresses"), key);
  const metaStore = OrderMetaStore.withKey(join(dir, "order-meta"), key);
  const reportStore = R.ReportStore.withKey(join(dir, "reports"), key);
  const decisions = new R.DecisionLog(join(dir, "decisions.json"));
  const cases = new CaseLog(join(dir, "cases.json"));
  const env: Record<string, string> = { QUOTE_SECRET: randomBytes(32).toString("hex"), EUR_USD_RATE: process.env.EUR_USD_RATE ?? "1.10" };
  const deps = { conn, metaStore, reportStore, decisions, cases };
  const address = { name: "Test Buyer", line1: "Teststr. 1", postcode: "10115", city: "Berlin", country: "DE" };
  const quote = (id: string, amount = 50) =>
    signQuote({ source: seller.source, id, url: `https://example.invalid/devnet/${id}`, title: `Devnet report test item ${id}`, seller: seller.handle, amount, currency: "EUR" }, env)!;
  const explorer = (kind: "tx" | "address", v: string) => `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;
  const onChain = () => retry429(() => sasR.sellerFindingsOnChain(authority, subject, cfg.rpcUrl));

  // --- 1. buy -----------------------------------------------------------------
  console.log("1. buy 0.50 EUR from the test seller; the operator fulfils");
  let order: string;
  {
    const r = await prepareCheckout({ quote: quote("1"), buyer: buyer.publicKey.toBase58(), address }, { env, conn, store, metaStore, upheldReports: await decisions.upheldCounts() });
    if (!r.ok) throw new Error(`checkout failed: ${r.error}`);
    order = r.order;
    const tx = Transaction.from(Buffer.from(r.transaction, "base64"));
    tx.partialSign(buyer);
    const sig = await retry429(() => conn.sendRawTransaction(tx.serialize()));
    await retry429(() => conn.confirmTransaction(sig, "confirmed"));
    await retry429(() => fulfilOrder(conn, operator, new PublicKey(order), "DEVNET-REPORT-TEST", store));
    const s = await readOrder(conn, new PublicKey(order));
    check("order fulfilled on chain, seller recorded for the report window", s.found && s.status === "fulfilled" && (await metaStore.get(order)) !== null, `${r.usdcDisplay}`);
    console.log(`         order ${explorer("address", order)}`);
  }

  // --- 2. the buyer reports -------------------------------------------------------
  console.log("\n2. the buyer reports the item");
  const photo = randomBytes(2048).toString("base64"); // stands in for the camera frame
  const description = "Logo stitching is crooked and the serial tag is missing; not the genuine product.";
  {
    const other = await R.createReportIntent({ order, wallet: stranger.publicKey.toBase58() }, deps);
    check("only the wallet that paid can report", !other.ok && other.status === 403);

    const intent = await R.createReportIntent({ order, wallet: buyer.publicKey.toBase58() }, deps);
    if (!intent.ok) throw new Error(intent.error);
    const msg = new TextEncoder().encode(intent.message);
    const forged = R.verifyIntentSignature(intent.intentId, Buffer.from(nacl.sign.detached(msg, stranger.secretKey)).toString("base64"));
    check("a signature from any other wallet is refused", !forged.ok && forged.status === 403);
    // Exactly what Phantom's signMessage produces: an ed25519 signature over the message bytes.
    const signed = R.verifyIntentSignature(intent.intentId, Buffer.from(nacl.sign.detached(msg, buyer.secretKey)).toString("base64"));
    check("the buyer's wallet signature is accepted", signed.ok);

    const verdict = (passedCheck: boolean) => async () =>
      ({ passed: passedCheck, confidence: passedCheck ? 0.93 : 0.2, observed: "STUB: item beside handwritten code", failureReason: passedCheck ? "" : "code not visible" }) as never;
    const submission = { intentId: intent.intentId, imageBase64: photo, mediaType: "image/jpeg", category: "counterfeit", description };

    const unbound = await R.submitReport({ ...submission, sessionId: "some-other-capture" }, { ...deps, verify: verdict(true) });
    check("a capture that isn't bound to this signed session is refused", !unbound.ok && unbound.status === 403);

    R.bindEvidenceSession(intent.intentId, "evidence-session-1");
    const failedPhoto = await R.submitReport({ ...submission, sessionId: "evidence-session-1" }, { ...deps, verify: verdict(false) });
    check("a photo that fails the check files nothing", failedPhoto.ok && !failedPhoto.passed && !(await reportStore.has(order)));

    const filed = await R.submitReport({ ...submission, sessionId: "evidence-session-1" }, { ...deps, verify: verdict(true) });
    check("report filed, and the seller's side of the case opened", filed.ok && filed.passed && (await cases.get(order))?.sellerKey === SELLER);

    const again = await R.createReportIntent({ order, wallet: buyer.publicKey.toBase58() }, deps);
    check("the same order can't be reported twice", !again.ok && again.status === 409);
    check("a pending report is never public", (await publicFindings(SELLER, deps)).length === 0);
  }

  // --- 3. the seller's right of reply -----------------------------------------------
  console.log("\n3. the seller's right of reply");
  const token = signSellerToken(SELLER, env)!;
  {
    const early = await R.decideReport(order, "upheld", { reportStore, decisions, cases });
    check("can't uphold before the seller is notified", !early.ok && /hasn't been notified/.test(early.error));

    await cases.markNotified(order, Math.floor(Date.now() / 1000)); // what `reports-admin notify` records
    console.log(`         seller link (sent through the marketplace order's messages): ${sellerLink("https://sigpath.example", token).replace(/#t=.*/, "#t=…")}`);
    const waiting = await R.decideReport(order, "upheld", { reportStore, decisions, cases });
    check("can't uphold inside the 7-day window without a reply", !waiting.ok && /days? left/.test(waiting.error));

    const [f] = await sellerFindings(SELLER, deps);
    const seen = JSON.stringify(f);
    check("the seller's link shows the report they're answering", f?.status === "pending" && f.buyerDescription === description && f.canReply);
    check("…but never the buyer's wallet or photo", !seen.includes(buyer.publicKey.toBase58()) && !seen.includes(photo.slice(0, 64)));

    const reply = await respondAsSeller({ token, order, text: "These are genuine, bought from the brand's EU distributor. Invoice available." }, { ...deps, env });
    check("the seller replies (once)", reply.ok && reply.kind === "reply");
  }

  // --- 4. upheld, on chain ------------------------------------------------------
  console.log("\n4. the reviewer upholds it: published on chain");
  {
    const before = await onChain();
    const publish = reportPublisher(cfg);
    // Retry a rate-limited publish only after checking it didn't land: a blind
    // retry could publish the same finding twice, at the next index.
    const publishOnce: typeof publish = async (r, i, at) => {
      for (let n = 0; ; n++) {
        const res = await publish(r, i, at);
        if (!("error" in res) || !is429(res.error) || n >= 4) return res;
        await pause(4000 * (n + 1));
        if ((await onChain()).upheld > before.upheld) {
          return { index: before.upheld, attestation: await sasR.reportAttestationAddress(authority, subject, before.upheld) };
        }
      }
    };
    const d = await R.decideReport(order, "upheld", { reportStore, decisions, cases, publish: publishOnce });
    if (!d.ok) throw new Error(d.error);
    check("published on chain at the seller's first index", d.decision.index === 0 && !!d.decision.attestation);
    console.log(`         attestation ${explorer("address", d.decision.attestation!)}`);
    check("the buyer's photo, words and wallet are deleted", !(await reportStore.has(order)));
  }

  // --- 5. the penalty ------------------------------------------------------------
  console.log("\n5. the penalty");
  {
    const counts = await decisions.upheldCounts();
    const listing = { id: "next", source: seller.source, seller: { handle: seller.handle } };
    const flags = upheldReportFlags([listing as never], counts);
    check("search flags the seller's listings", flags.length === 1 && flags[0].kind === "upheld_reports");
    const blocked = await prepareCheckout({ quote: quote("2"), buyer: buyer.publicKey.toBase58(), address }, { env, conn, store, metaStore, upheldReports: counts });
    check("checkout refuses to pay this seller", !blocked.ok && blocked.status === 409);
    const [pub] = await publicFindings(SELLER, deps);
    check("public finding shows the seller's reply beside it", pub?.status === "upheld" && /genuine/.test(pub.reply?.text ?? ""));
    await pause(2000);
    const chain = await onChain();
    check("on chain, from the handle alone: 1 upheld, 1 active", chain.upheld === 1 && chain.active === 1, JSON.stringify(chain));
  }

  // --- 6. appeal and reversal ------------------------------------------------------
  console.log("\n6. the seller appeals; the finding is reversed");
  {
    const appeal = await respondAsSeller({ token, order, text: "The returned item has a different serial from the one we shipped." }, { ...deps, env });
    check("the seller appeals (once)", appeal.ok && appeal.kind === "appeal");

    const publishReversal = reversalPublisher(cfg);
    const reverseOnce: typeof publishReversal = async (dec, at) => {
      const addr = await sasR.reversalAttestationAddress(authority, subject, dec.index!);
      for (let n = 0; ; n++) {
        const res = await publishReversal(dec, at);
        if (!("error" in res) || !is429(res.error) || n >= 4) return res;
        await pause(4000 * (n + 1));
        if (await retry429(() => conn.getAccountInfo(new PublicKey(addr)))) return { attestation: addr };
      }
    };
    const rev = await R.reverseDecision(order, { decisions, publishReversal: reverseOnce });
    if (!rev.ok) throw new Error(rev.error);
    check("reversal published on chain first, then recorded", !!rev.decision.reversal?.attestation);
    console.log(`         reversal    ${explorer("address", rev.decision.reversal!.attestation!)}`);

    const counts = await decisions.upheldCounts();
    check("the search flag lifts", upheldReportFlags([{ id: "next", source: seller.source, seller: { handle: seller.handle } } as never], counts).length === 0);
    const allowed = await prepareCheckout({ quote: quote("3"), buyer: buyer.publicKey.toBase58(), address }, { env, conn, store, metaStore, upheldReports: counts });
    check("checkout will pay this seller again", allowed.ok, allowed.ok ? "transaction prepared, not sent" : allowed.error);
    const [pub] = await publicFindings(SELLER, deps);
    check("the finding stays listed, marked reversed", pub?.status === "reversed" && /different serial/.test(pub.appeal?.text ?? ""));
    await pause(2000);
    const chain = await onChain();
    check("on chain: 1 upheld, reversed [#0], 0 active", chain.upheld === 1 && chain.reversed.join() === "0" && chain.active === 0, JSON.stringify(chain));
  }

  const endOperatorSol = await retry429(() => conn.getBalance(operator.publicKey));
  console.log(`\noperator SOL spent: ${((startOperatorSol - endOperatorSol) / 1e9).toFixed(6)} (attestation rent, buyer top-up, fees)`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("THE REPORT FLOW WORKS ON DEVNET — PENALTY, RIGHT OF REPLY AND REVERSAL ON CHAIN");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
