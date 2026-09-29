/**
 * scripts/reports-admin.ts — review fake-product reports.
 *
 *   npx tsx scripts/reports-admin.ts list                  pending reports (no buyer data)
 *   npx tsx scripts/reports-admin.ts show <order>          the evidence, for review
 *   npx tsx scripts/reports-admin.ts uphold <order>        publish on chain, flag the seller
 *   npx tsx scripts/reports-admin.ts dismiss <order>       close it, publish nothing
 *   npx tsx scripts/reports-admin.ts sweep                 expire stale reports, clear old order records
 *   npx tsx scripts/reports-admin.ts bootstrap             register the report schema on SAS
 *   npx tsx scripts/reports-admin.ts seller <src> <handle> count a seller's upheld reports ON CHAIN
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
  const { ReportStore, DecisionLog, decideReport, expireStaleReports, PENDING_REPORT_MAX_SECS } = await import(
    "../lib/reports/reports"
  );
  const { OrderMetaStore } = await import("../lib/reports/order-meta");
  const { reportPublisher } = await import("../lib/reports/publish");
  const { chainStateReader, ordersRpcUrl } = await import("../lib/checkout/checkout");
  const { sasConfigFromEnv, signer } = await import("../lib/chains/solana/sas");
  const { bootstrapReportSchema, countSellerReportsOnChain } = await import("../lib/chains/solana/sas-reports");
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
        console.log(order);
        console.log(
          `   ${got ? `${got.record.category.padEnd(17)} seller ${got.record.seller.source}:${got.record.seller.handle}` : "(record unreadable)"}`,
        );
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
      console.log(`\nThen:  uphold ${order}   or   dismiss ${order}`);
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
      const n = await countSellerReportsOnChain(authority, await subjectHash(source, handle), rpc);
      console.log(`${source}:${handle}  upheld fake-product reports on chain: ${n}`);
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
