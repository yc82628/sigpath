/**
 * scripts/devnet-verified-seller.ts — the verified-seller badge, end to end, on devnet.
 *
 *   npx tsx scripts/devnet-verified-seller.ts
 *
 * Drives the same functions the /api/sellers/claim routes and reports-admin
 * call, with the devnet test wallet (.data/devnet-test-buyer.json) as the
 * seller's wallet:
 *
 *   1. claim: code -> listing containing it (demo marketplace) -> wallet
 *      signature -> live photo -> token issued ON CHAIN into the wallet
 *   2. the badge shows: search row, seller page, readable on chain by handle
 *   3. a fake-product report against the seller is upheld: published on chain,
 *      and the token is BURNED by the same uphold — the badge disappears
 *   4. while the finding stands, the seller can't verify again
 *   5. the finding is reversed on appeal: the seller is eligible again
 *   6. cleanup: the wallet closes its now-empty token account, getting that rent back
 *
 * WHAT IS STUBBED: the photo check (a terminal can't take the photo — it has
 * its own tests and was proved live on camera) and the listing (the demo
 * marketplace's "handle:text" stands in for eBay's API, which is unit-tested
 * against eBay's response shape). The uphold in step 3 decides a report record
 * placed directly in a throwaway store; filing a report for real is what
 * scripts/devnet-report.ts proves.
 *
 * Throwaway stores and secrets; a seller handle unique to this run on the stub
 * namespace. Devnet only.
 */

import { readFileSync, existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import nacl from "tweetnacl";
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
  const C = await import("../lib/sellers/claim");
  const { VerifiedSellerLog, badgeFor } = await import("../lib/sellers/verified-log");
  const { badgeIssuer, badgeRevoker, listingLookup, sellerSubject } = await import("../lib/sellers/badges");
  const R = await import("../lib/reports/reports");
  const { CaseLog } = await import("../lib/reports/cases");
  const { reportPublisher, reversalPublisher } = await import("../lib/reports/publish");
  const { sasConfigFromEnv, signer } = await import("../lib/chains/solana/sas");
  const V = await import("../lib/chains/solana/sas-verified");
  const { sellerFindingsOnChain } = await import("../lib/chains/solana/sas-reports");

  const cfg = sasConfigFromEnv();
  if (!cfg || !/devnet/.test(cfg.rpcUrl)) throw new Error("SAS must be configured on devnet.");
  if (!existsSync(".data/devnet-test-buyer.json")) throw new Error("Run scripts/devnet-checkout.ts first to create the test wallet.");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".data/devnet-test-buyer.json", "utf8"))));
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const authority = (await signer(cfg)).address;
  const operatorBefore = await retry429(() => conn.getBalance(new PublicKey(authority)));
  const walletBefore = await retry429(() => conn.getBalance(wallet.publicKey));

  const handle = `sigpath-devnet-verified-${Date.now()}`;
  const KEY = `stub:${handle}`;
  const subject = await sellerSubject(KEY);
  console.log(`seller   ${KEY}  (test seller, unique to this run)`);
  console.log(`wallet   ${wallet.publicKey.toBase58()}\n`);

  const boot = await V.bootstrapVerifiedSchema(cfg);
  if (boot.status === "error" || boot.status === "disabled") throw new Error(boot.reason);

  const dir = mkdtempSync(join(tmpdir(), "sigpath-devnet-verified-"));
  const env: Record<string, string> = { QUOTE_SECRET: randomBytes(32).toString("hex") };
  const log = new VerifiedSellerLog(join(dir, "verified.json"));
  const decisions = new R.DecisionLog(join(dir, "decisions.json"));
  const cases = new CaseLog(join(dir, "cases.json"));
  const reportStore = R.ReportStore.withKey(join(dir, "reports"), randomBytes(32));
  const proveDeps = { env, lookup: listingLookup(env), log, upheldCounts: () => decisions.upheldCounts() };
  const passes = async () => ({ passed: true, confidence: 0.94, observed: "STUB: code beside face", failureReason: "" });

  async function claimUpToCamera() {
    const start = C.startClaim({ wallet: wallet.publicKey.toBase58() }, env);
    if (!start.ok) throw new Error(start.error);
    // The demo marketplace's stand-in for "a listing by <handle> whose text contains the code".
    return { start, proof: await C.proveHandle({ claimToken: start.claimToken, source: "stub", listingId: `${handle}:Genuine boots. ${start.code}` }, proveDeps) };
  }

  // --- 1. claim ------------------------------------------------------------------
  console.log("1. claim the badge");
  let mint: string;
  {
    const { start, proof } = await claimUpToCamera();
    check("the listing containing the code proves the handle", proof.ok && proof.sellerKey === KEY, start.code);
    if (!proof.ok) throw new Error(proof.error);
    const sig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(proof.message), wallet.secretKey)).toString("base64");
    check("the wallet's signature over the claim is accepted", C.verifyClaimSignature({ provenToken: proof.provenToken, signature: sig }, env).ok);
    C.bindClaimSession(proof.provenToken, "devnet-session");
    const done = await C.completeClaim(
      { provenToken: proof.provenToken, sessionId: "devnet-session", imageBase64: "AAAA", mediaType: "image/jpeg" },
      { env, log, upheldCounts: () => decisions.upheldCounts(), verify: passes, issue: badgeIssuer(cfg) },
    );
    if (!done.ok || !done.passed) throw new Error(!done.ok ? done.error : done.reason);
    mint = done.badge.mint;
    check("token issued on chain into the seller's wallet", !!done.badge.attestation);
    console.log(`         attestation https://explorer.solana.com/address/${done.badge.attestation}?cluster=devnet`);
    console.log(`         token       https://explorer.solana.com/address/${mint}?cluster=devnet`);
  }

  // --- 2. the badge shows ---------------------------------------------------------
  console.log("\n2. the badge shows");
  {
    check("search and seller page show the badge", badgeFor(KEY, await log.all(), await decisions.upheldCounts()) !== null);
    await pause(1500);
    const chain = await retry429(() => V.readVerifiedSeller(authority, subject, cfg.rpcUrl));
    check("on chain, from the handle alone: valid, held by the seller's wallet", chain.status === "valid" && chain.holder === wallet.publicKey.toBase58());
    const again = await claimUpToCamera();
    check("the same account can't be claimed twice", !again.proof.ok && again.proof.status === 409);
  }

  // --- 3. an upheld report burns it ---------------------------------------------------
  console.log("\n3. a fake-product report against the seller is upheld");
  // Stores key records by order address; any fresh address will do for a record placed directly.
  const order = Keypair.generate().publicKey.toBase58();
  {
    await reportStore.put(order, {
      order,
      buyer: "not-published",
      seller: { source: "stub", handle },
      listing: { source: "stub", id: "1", url: "https://example.invalid/devnet/1", title: "Devnet test item", amount: 50, currency: "EUR" },
      category: "counterfeit",
      description: "Devnet test: stitching and serial tag don't match the genuine product.",
      evidence: { imageBase64: "", mediaType: "image/jpeg", sha256: "ab".repeat(32), observed: "", confidence: 1 },
    });
    await cases.open(order, KEY, Math.floor(Date.now() / 1000));
    await cases.markNotified(order, Math.floor(Date.now() / 1000));
    await cases.respond(order, "reply", { text: "We dispute this report.", at: Math.floor(Date.now() / 1000) });

    const d = await R.decideReport(order, "upheld", {
      reportStore,
      decisions,
      cases,
      publish: reportPublisher(cfg),
      revokeBadge: badgeRevoker(log, cfg),
    });
    if (!d.ok) throw new Error(d.error);
    check("the finding is published on chain", !!d.decision.attestation);
    check("the same uphold burned the verified-seller token", d.ok && !!d.badge?.revoked && !d.badge.chainError, d.badge?.chainError ?? "");
    if (d.badge?.signature) console.log(`         burned      https://explorer.solana.com/tx/${d.badge.signature}?cluster=devnet`);
    check("the badge is gone from search and the seller page", badgeFor(KEY, await log.all(), await decisions.upheldCounts()) === null);
    await pause(1500);
    check("on chain, the handle reads as unverified", (await retry429(() => V.readVerifiedSeller(authority, subject, cfg.rpcUrl))).status === "none");
  }

  // --- 4. no buying back a clean look ------------------------------------------------------
  console.log("\n4. while the finding stands");
  {
    const again = await claimUpToCamera();
    check("the seller can't verify again", !again.proof.ok && /upheld fake-product report/.test(again.proof.error));
  }

  // --- 5. reversed on appeal ------------------------------------------------------------
  console.log("\n5. the finding is reversed on appeal");
  {
    const rev = await R.reverseDecision(order, { decisions, publishReversal: reversalPublisher(cfg) });
    if (!rev.ok) throw new Error(rev.error);
    await pause(1500);
    const f = await retry429(() => sellerFindingsOnChain(authority, subject, cfg.rpcUrl));
    check("on chain: 1 upheld, 1 reversed, 0 active", f.upheld === 1 && f.active === 0, JSON.stringify(f));
    const again = await claimUpToCamera();
    check("the seller is eligible to verify again (not re-issued here)", again.proof.ok);
  }

  // --- 6. cleanup ---------------------------------------------------------------------
  console.log("\n6. cleanup");
  {
    const ata = new PublicKey(await V.token2022Ata(wallet.publicKey.toBase58() as never, mint as never));
    // Token-2022 CloseAccount (9): the owner closes its empty account, rent to itself.
    const close = new TransactionInstruction({
      programId: new PublicKey(V.TOKEN_2022_PROGRAM),
      keys: [
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    });
    await retry429(() => sendAndConfirmTransaction(conn, new Transaction().add(close), [wallet], { commitment: "confirmed" }));
    check("the wallet closed its empty token account and got the rent back", (await conn.getAccountInfo(ata)) === null);
  }

  const operatorAfter = await retry429(() => conn.getBalance(new PublicKey(authority)));
  const walletAfter = await retry429(() => conn.getBalance(wallet.publicKey));
  console.log(`\noperator SOL spent: ${((operatorBefore - operatorAfter) / 1e9).toFixed(6)} (report + reversal attestations, and the token account's rent, now the wallet's; the badge's mint and attestation rent came back when it was burned)`);
  console.log(`wallet SOL change:  ${((walletAfter - walletBefore) / 1e9).toFixed(6)} (the token account's rent, which the operator paid at issue, went to the wallet when it closed the account, less the fee)`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("VERIFIED SELLER WORKS ON DEVNET — CLAIMED, SHOWN, BURNED ON AN UPHELD REPORT, BLOCKED, ELIGIBLE AGAIN AFTER REVERSAL");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
