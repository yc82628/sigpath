/**
 * scripts/reports-admin.ts — review fake-product reports.
 *
 *   npx tsx scripts/reports-admin.ts list                  pending reports (no buyer data)
 *   npx tsx scripts/reports-admin.ts show <order>          the evidence and the seller's reply, for review
 *   npx tsx scripts/reports-admin.ts notify <order>        the notice to send the seller; starts their 7 days
 *   npx tsx scripts/reports-admin.ts uphold <order>        publish on chain, flag the seller
 *   npx tsx scripts/reports-admin.ts dismiss <order>       close it, publish nothing
 *   npx tsx scripts/reports-admin.ts reverse <order>       overturn an upheld finding (e.g. on appeal)
 *   npx tsx scripts/reports-admin.ts seller-link <src> <h> a reply link for a seller who contacted you
 *   npx tsx scripts/reports-admin.ts sweep                 expire stale reports, clear old order records
 *   npx tsx scripts/reports-admin.ts bootstrap             register the report, verified-seller and business schemas on SAS
 *   npx tsx scripts/reports-admin.ts seller <src> <handle> a seller's findings and badge ON CHAIN
 *   npx tsx scripts/reports-admin.ts badges                verified sellers, and any badge whose burn failed
 *   npx tsx scripts/reports-admin.ts revoke-badge <src:h>  burn a seller's verified-seller token
 *   npx tsx scripts/reports-admin.ts business <wallet>     a verified business: SigPath's record and ON CHAIN
 *   npx tsx scripts/reports-admin.ts publish-business <w>  (re)publish a verified business's attestation
 *   npx tsx scripts/reports-admin.ts revoke-business <w>   close a business's attestation (if uphold's close failed)
 *
 * THE SELLER'S RIGHT OF REPLY
 * A report cannot be upheld until the seller has been notified and has either
 * replied or had seven days to. SigPath is the buyer of record on the
 * marketplace, so `notify` prints a message to send through THAT ORDER's
 * messaging — the one channel that reaches exactly this seller — with a
 * private link. Holding the link is what proves they are the seller.
 *
 * THE REVIEWER'S JOB
 * The photo check proved the buyer had the item and took the photo just now.
 * It did not — cannot — tell you whether the item is fake. You do. Uphold only
 * when the evidence shows it: an upheld report flags the seller everywhere
 * SigPath reaches and is published permanently on chain. When in doubt,
 * dismiss; a missed fake costs less than a false accusation.
 *
 * `show` writes the photo to a temporary file so you can look at it. That file
 * is a copy outside the encrypted store, so uphold and dismiss delete it too.
 *
 * `seller` reads the chain only — no keys, no local files — exactly as any
 * other app would, to show the penalty is readable without SigPath.
 */

import { readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

const evidencePath = (order: string) => join(tmpdir(), `sigpath-evidence-${order}.jpg`);

function days(secs: number) {
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { ReportStore, DecisionLog, decideReport, reverseDecision, expireStaleReports, PENDING_REPORT_MAX_SECS } =
    await import("../lib/reports/reports");
  const { OrderMetaStore } = await import("../lib/reports/order-meta");
  const { reportPublisher, reversalPublisher } = await import("../lib/reports/publish");
  const { CaseLog, REPLY_WINDOW_SECS } = await import("../lib/reports/cases");
  const { signSellerToken, sellerLink } = await import("../lib/reports/seller-access");
  const { sellerKey } = await import("../lib/marketplace/types");
  const cases = CaseLog.fromEnv();
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim() || "http://localhost:3000";
  const date = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const { chainStateReader, ordersRpcUrl } = await import("../lib/checkout/checkout");
  const { sasConfigFromEnv, signer } = await import("../lib/chains/solana/sas");
  const { bootstrapReportSchema, sellerFindingsOnChain } = await import("../lib/chains/solana/sas-reports");
  const { subjectHash } = await import("../lib/crypto/hash");
  const { Connection } = await import("@solana/web3.js");
  const { address } = await import("@solana/kit");
  const { VerifiedSellerLog } = await import("../lib/sellers/verified-log");
  const { badgeRevoker, sellerSubject } = await import("../lib/sellers/badges");
  const { bootstrapVerifiedSchema, readVerifiedSeller } = await import("../lib/chains/solana/sas-verified");
  const { bootstrapBusinessSchema, readVerifiedBusiness, vatHash } = await import("../lib/chains/solana/sas-business");
  const { BusinessLog, businessView } = await import("../lib/sellers/business");
  const { businessPublisher, businessRevoker } = await import("../lib/sellers/business-chain");

  const reportStore = ReportStore.fromEnv();
  const decisions = DecisionLog.fromEnv();
  const needStore = () => {
    if (!reportStore) throw new Error("ADDRESS_KEY is not set — there is no report store to read.");
    return reportStore;
  };

  switch (cmd) {
    case "list": {
      const pending = await needStore().list();
      if (!pending.length) {
        console.log("No reports awaiting review.");
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      for (const { order, createdAt } of pending) {
        const got = await needStore().get(order).catch(() => null);
        const left = PENDING_REPORT_MAX_SECS - (now - createdAt);
        const c = await cases.get(order);
        const seller = !c?.notifiedAt
          ? "NOT NOTIFIED — run notify"
          : c.reply
            ? "seller replied — can be decided"
            : now >= c.notifiedAt + REPLY_WINDOW_SECS
              ? "reply window closed — can be decided"
              : `awaiting seller until ${date(c.notifiedAt + REPLY_WINDOW_SECS)}`;
        console.log(order);
        console.log(
          `   ${got ? `${got.record.category.padEnd(17)} seller ${got.record.seller.source}:${got.record.seller.handle}` : "(record unreadable)"}`,
        );
        console.log(`   ${seller}`);
        console.log(`   filed ${days(now - createdAt)} ago · expires unreviewed in ${days(Math.max(0, left))}\n`);
      }
      return;
    }

    case "show": {
      const order = args[0];
      if (!order) throw new Error("Usage: show <order>");
      const got = await needStore().get(order);
      if (!got) throw new Error("No pending report for that order.");
      const r = got.record;
      writeFileSync(evidencePath(order), Buffer.from(r.evidence.imageBase64, "base64"), { mode: 0o600 });
      console.log(`order      ${order}`);
      console.log(`category   ${r.category}`);
      console.log(`seller     ${r.seller.source}:${r.seller.handle}`);
      console.log(`item       ${r.listing.title}`);
      console.log(`           ${r.listing.url}`);
      console.log(`\nbuyer says:\n  ${r.description.replace(/\n/g, "\n  ")}`);
      console.log(`\nphoto check (live + code only — NOT a verdict on the item):`);
      console.log(`  confidence ${r.evidence.confidence.toFixed(2)}`);
      console.log(`  saw: ${r.evidence.observed}`);
      console.log(`\nevidence   ${evidencePath(order)}`);
      console.log(`sha256     ${r.evidence.sha256}`);

      const c = await cases.get(order);
      console.log(`\nseller's side:`);
      if (!c?.notifiedAt) console.log(`  not notified yet — run: notify ${order}`);
      else {
        console.log(`  notified   ${date(c.notifiedAt)} · reply window until ${date(c.notifiedAt + REPLY_WINDOW_SECS)}`);
        console.log(c.reply ? `  replied    ${date(c.reply.at)}:\n    ${c.reply.text.replace(/\n/g, "\n    ")}` : "  no reply yet");
      }
      console.log(`\nThen:  uphold ${order}   or   dismiss ${order}`);
      return;
    }

    case "notify": {
      const order = args[0];
      if (!order) throw new Error("Usage: notify <order>");
      const got = await needStore().get(order);
      if (!got) throw new Error("No pending report for that order.");
      const r = got.record;
      const key = sellerKey(r.seller.source, r.seller.handle);
      const token = signSellerToken(key);
      if (!token) throw new Error("QUOTE_SECRET is not set — seller links can't be signed.");
      const c = await cases.markNotified(order, Math.floor(Date.now() / 1000));
      const replyBy = date(c.notifiedAt! + REPLY_WINDOW_SECS);

      console.log(`Send this to ${r.seller.source}:${r.seller.handle} through the ${r.seller.source} messages`);
      console.log(`on the order SigPath placed for:\n  ${r.listing.title}\n  ${r.listing.url}\n`);
      console.log("-------------------------------------------------------------------------------");
      console.log(`Hello — a buyer we purchased this item for has reported it as`);
      console.log(`${r.category === "counterfeit" ? "not genuine" : "materially different from the listing"}. Before anything is decided, you have`);
      console.log(`until ${replyBy} to respond. You can read the report and reply here:`);
      console.log(`\n${sellerLink(baseUrl, token)}\n`);
      console.log(`The link is private to you. Nothing is published unless the report is`);
      console.log(`upheld after review, and your reply is shown alongside any finding.`);
      console.log("-------------------------------------------------------------------------------");
      console.log(`\nReply window recorded: until ${replyBy}. Re-running this does not restart it.`);
      return;
    }

    case "seller-link": {
      const [source, handle] = args;
      if (!source || !handle) throw new Error("Usage: seller-link <source> <handle>");
      const token = signSellerToken(sellerKey(source, handle));
      if (!token) throw new Error("QUOTE_SECRET is not set — seller links can't be signed.");
      console.log("Only send this after confirming it is really the seller — ideally by replying");
      console.log("through the marketplace's own messages to that account, not to an email address");
      console.log("someone gave you. The link lets its holder reply as this seller.\n");
      console.log(sellerLink(baseUrl, token));
      return;
    }

    case "reverse": {
      const order = args[0];
      if (!order) throw new Error("Usage: reverse <order>");
      const res = await reverseDecision(order, { decisions, publishReversal: reversalPublisher() });
      if (!res.ok) throw new Error(res.error);
      console.log(`reversed   ${order}`);
      console.log(`seller     ${res.decision.sellerKey} — no longer flagged for this finding`);
      if (res.decision.reversal?.attestation) {
        console.log(`on chain   ${res.decision.reversal.attestation}  (reverses report #${res.decision.index})`);
      }
      return;
    }

    case "uphold":
    case "dismiss": {
      const order = args[0];
      if (!order) throw new Error(`Usage: ${cmd} <order>`);
      const status = cmd === "uphold" ? "upheld" : "dismissed";
      const res = await decideReport(order, status, {
        reportStore: needStore(),
        decisions,
        cases,
        publish: status === "upheld" ? reportPublisher() : undefined,
        revokeBadge: status === "upheld" ? badgeRevoker(VerifiedSellerLog.fromEnv()) : undefined,
      });
      if (!res.ok) throw new Error(res.error);
      rmSync(evidencePath(order), { force: true });
      console.log(`${status.padEnd(10)} ${order}`);
      console.log(`seller     ${res.decision.sellerKey}`);
      if (res.decision.attestation) {
        console.log(`on chain   ${res.decision.attestation}  (report #${res.decision.index} against this seller)`);
      }
      if (res.badge?.revoked) {
        console.log(
          res.badge.chainError
            ? `badge      revoked in SigPath; burning the token FAILED (${res.badge.chainError}) — retry: revoke-badge ${res.decision.sellerKey}`
            : `badge      verified-seller token burned  ${res.badge.signature}`,
        );
      }
      if (status === "upheld") {
        const biz = await businessRevoker(BusinessLog.fromEnv(), VerifiedSellerLog.fromEnv())(res.decision.sellerKey).catch((e: unknown) => ({
          wallet: "?",
          signature: undefined as string | undefined,
          chainError: e instanceof Error ? e.message : String(e),
        }));
        if (biz) {
          console.log(
            biz.chainError
              ? `business   suspended in SigPath; closing its attestation FAILED (${biz.chainError}) — retry: revoke-business ${biz.wallet}`
              : `business   verified-business attestation closed  ${biz.signature ?? "(none on chain)"}`,
          );
        }
      }
      console.log(`buyer data deleted: photo, description, wallet`);
      return;
    }

    case "sweep": {
      const expired = await expireStaleReports({ reportStore: needStore(), decisions });
      for (const o of expired) console.log(`expired unreviewed  ${o}`);
      const meta = OrderMetaStore.fromEnv();
      if (meta) {
        const conn = new Connection(ordersRpcUrl(), "confirmed");
        for (const d of await meta.sweep(chainStateReader(conn))) console.log(`order record deleted ${d.order} (${d.reason})`);
      }
      if (!expired.length) console.log("No stale reports.");
      return;
    }

    case "bootstrap": {
      const cfg = sasConfigFromEnv();
      if (!cfg) throw new Error("Set SAS_ENABLED=true and ISSUER_SECRET in .env.local.");
      const r = await bootstrapReportSchema(cfg);
      if (r.status === "error" || r.status === "disabled") throw new Error(r.reason);
      console.log(`report schema ${r.status === "exists" ? "already registered" : "registered"}: ${r.attestation}`);
      if (r.status === "ok") console.log(`tx ${r.signature}`);
      const v = await bootstrapVerifiedSchema(cfg);
      if (v.status === "error" || v.status === "disabled") throw new Error(v.reason);
      console.log(`verified-seller schema ${v.status === "exists" ? "already tokenized" : "registered and tokenized"}: mint ${v.attestation}`);
      const b = await bootstrapBusinessSchema(cfg);
      if (b.status === "error" || b.status === "disabled") throw new Error(b.reason);
      console.log(`business schema ${b.status === "exists" ? "already registered" : "registered"}: ${b.attestation}`);
      return;
    }

    case "business": {
      const wallet = args[0];
      if (!wallet) throw new Error("Usage: business <wallet>");
      const b = await BusinessLog.fromEnv().byWallet(wallet);
      const now = Math.floor(Date.now() / 1000);
      if (b) {
        const v = businessView(b, await VerifiedSellerLog.fromEnv().all(), await decisions.upheldCounts(), now);
        console.log(`SigPath    ${v.status}${v.statusReason ? ` (${v.statusReason})` : ""} · ${v.accounts.length} linked account(s) · profile /business/${b.id}`);
        if (b.onChain) console.log(`recorded   ${b.onChain.attestation || "-"}${b.onChain.error ? ` · last publish FAILED: ${b.onChain.error}` : ""}${b.onChain.revokedAt ? ` · closed ${date(b.onChain.revokedAt)}` : ""}`);
      } else console.log("SigPath    no business record for this wallet");
      const cfg = sasConfigFromEnv();
      if (!cfg) return;
      const chain = await readVerifiedBusiness((await signer(cfg)).address, wallet, cfg.rpcUrl);
      if (chain.status !== "valid") console.log(`chain      ${chain.status.toUpperCase()}`);
      else {
        const vatOk = b?.vat ? (vatHash(b.vat.country, b.vat.number) === chain.vatHash ? "matches" : "DIFFERS") : "?";
        console.log(`chain      valid · ${chain.attestation} · ${chain.country} · VAT hash ${vatOk} · ${chain.linkedAccounts} account(s) · until ${date(chain.expiresAt)}`);
      }
      return;
    }

    case "revoke-business": {
      const wallet = args[0];
      if (!wallet) throw new Error("Usage: revoke-business <wallet>");
      const cfg = sasConfigFromEnv();
      if (!cfg) throw new Error("Set SAS_ENABLED=true and ISSUER_SECRET in .env.local.");
      const { revokeBusinessAttestation } = await import("../lib/chains/solana/sas-business");
      const r = await revokeBusinessAttestation(cfg, wallet);
      if (r.status === "error") throw new Error(r.reason);
      const log = BusinessLog.fromEnv();
      if (await log.byWallet(wallet)) {
        await log.update(wallet, (b) => ({ ...b, onChain: { ...(b.onChain ?? { attestation: "", publishedAt: 0 }), revokedAt: Math.floor(Date.now() / 1000), revokeSignature: r.status === "ok" ? r.signature : undefined } }));
      }
      console.log(r.status === "ok" ? `closed     ${r.attestation}
tx ${r.signature}` : "nothing on chain for that wallet");
      return;
    }

    case "publish-business": {
      const wallet = args[0];
      if (!wallet) throw new Error("Usage: publish-business <wallet>");
      const publish = businessPublisher();
      if (!publish) throw new Error("Set SAS_ENABLED=true and ISSUER_SECRET in .env.local.");
      const log = BusinessLog.fromEnv();
      const b = await log.byWallet(wallet);
      if (!b) throw new Error("No business record for that wallet.");
      const v = businessView(b, await VerifiedSellerLog.fromEnv().all(), await decisions.upheldCounts());
      if (v.status !== "verified") throw new Error(`Not verified (${v.status}): nothing to publish.`);
      const onChain = await publish(b, v);
      await log.update(wallet, (cur) => ({ ...cur, onChain }));
      if (onChain.error) throw new Error(`Publishing failed: ${onChain.error}`);
      console.log(`published  ${onChain.attestation}\ntx ${onChain.signature}`);
      return;
    }

    case "badges": {
      const all = await VerifiedSellerLog.fromEnv().all();
      const now = Math.floor(Date.now() / 1000);
      if (!Object.keys(all).length) console.log("No verified sellers.");
      for (const [key, { current: b }] of Object.entries(all)) {
        const state = b.revoked
          ? b.revoked.chainError
            ? `REVOKED, burn FAILED — run: revoke-badge ${key}`
            : `revoked ${date(b.revoked.at)} (${b.revoked.reason})`
          : now >= b.expiresAt
            ? `lapsed ${date(b.expiresAt)}`
            : `verified ${date(b.verifiedAt)}, until ${date(b.expiresAt)}`;
        // Search shows badges from this log alone; the seller page also asks the
        // chain. They can only disagree if the holder burned their own token —
        // so check, and say so, rather than let search show a badge the chain doesn't back.
        let chain = "";
        const cfg = sasConfigFromEnv();
        if (cfg && !b.revoked && now < b.expiresAt) {
          const onChain = await readVerifiedSeller((await signer(cfg)).address, await sellerSubject(key), cfg.rpcUrl).catch(() => null);
          chain = !onChain
            ? "   chain: couldn't be read\n"
            : onChain.status === "valid"
              ? "   chain: valid, token held\n"
              : `   chain: ${onChain.status.toUpperCase()} — search still shows this badge; run: revoke-badge ${key}\n`;
        }
        console.log(`${key}\n   ${state}\n   wallet ${b.wallet} · attestation ${b.attestation}\n${chain}`);
      }
      return;
    }

    case "revoke-badge": {
      const key = args[0];
      if (!key || !key.includes(":")) throw new Error("Usage: revoke-badge <source:handle>");
      const r = await badgeRevoker(VerifiedSellerLog.fromEnv())(key, args.slice(1).join(" ") || "revoked by reviewer");
      if (!r.revoked) throw new Error("That seller holds no active badge in SigPath's log.");
      if (r.chainError) throw new Error(`Recorded as revoked, but burning the token failed: ${r.chainError}`);
      console.log(`revoked    ${key}\ntoken burned ${r.signature}`);
      return;
    }

    case "seller": {
      const [source, handle] = args;
      if (!source || !handle) throw new Error("Usage: seller <source> <handle>");
      // Only the issuer's PUBLIC address is needed. It is derived from the key
      // here for convenience; --authority <address> skips the key entirely.
      const ai = args.indexOf("--authority");
      let authority;
      if (ai !== -1) authority = address(args[ai + 1]);
      else {
        const cfg = sasConfigFromEnv();
        if (!cfg) throw new Error("Pass --authority <issuer address>, or configure SAS.");
        authority = (await signer(cfg)).address;
      }
      const rpc = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
      const f = await sellerFindingsOnChain(authority, await subjectHash(source, handle), rpc);
      console.log(`${source}:${handle}  on chain:`);
      console.log(`  findings upheld  ${f.upheld}`);
      console.log(`  reversed         ${f.reversed.length}${f.reversed.length ? ` (report #${f.reversed.join(", #")})` : ""}`);
      console.log(`  ACTIVE           ${f.active}`);
      const b = await readVerifiedSeller(authority, await sellerSubject(`${source}:${handle}`), rpc);
      console.log(`  verified badge   ${b.status}${b.status === "valid" ? ` — held by ${b.holder}, until ${date(b.expiresAt)}` : ""}`);
      return;
    }

    default:
      console.error("Usage: reports-admin.ts list | show | notify | uphold | dismiss | reverse | seller-link | sweep | bootstrap | seller | badges | revoke-badge");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
