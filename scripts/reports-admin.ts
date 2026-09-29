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
 *   npx tsx scripts/reports-admin.ts bootstrap             register the report schema on SAS
 *   npx tsx scripts/reports-admin.ts seller <src> <handle> a seller's findings ON CHAIN, reversals included
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
      });
      if (!res.ok) throw new Error(res.error);
      rmSync(evidencePath(order), { force: true });
      console.log(`${status.padEnd(10)} ${order}`);
      console.log(`seller     ${res.decision.sellerKey}`);
      if (res.decision.attestation) {
        console.log(`on chain   ${res.decision.attestation}  (report #${res.decision.index} against this seller)`);
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
      return;
    }

    default:
      console.error("Usage: reports-admin.ts list | show | uphold | dismiss | sweep | bootstrap | seller");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
