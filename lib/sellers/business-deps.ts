/** The real dependencies of the business steps: the logs on disk, DNS, the network. */

import { promises as dns } from "dns";
import { DecisionLog } from "../reports/reports";
import { VerifiedSellerLog } from "./verified-log";
import { BusinessLog } from "./business";
import type { BusinessDeps } from "./business-api";
import { businessPublisher } from "./business-chain";
import { Connection, PublicKey } from "@solana/web3.js";
import { ordersRpcUrl } from "../checkout/checkout";
import { eurUsdRate } from "../checkout/fx";
import type { PlanChain } from "./business-api";
import type { ChainPayment } from "./plan";

/** The plan payments, read from the same Solana network as the checkout. */
function planChain(env: Record<string, string | undefined>): PlanChain {
  const conn = new Connection(ordersRpcUrl(env), "confirmed");
  return {
    latestBlockhash: () => conn.getLatestBlockhash("confirmed"),
    rate: () => eurUsdRate(env),
    async paymentsFor(reference) {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(reference), { limit: 10 }, "confirmed");
      const out: ChainPayment[] = [];
      for (const s of sigs) {
        const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx?.meta) continue;
        const balances = (list: typeof tx.meta.preTokenBalances) =>
          (list ?? []).map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, amount: b.uiTokenAmount.amount }));
        out.push({ signature: s.signature, err: tx.meta.err, blockTime: tx.blockTime, pre: balances(tx.meta.preTokenBalances), post: balances(tx.meta.postTokenBalances) });
      }
      return out;
    },
  };
}

export function businessDepsFromEnv(env: Record<string, string | undefined> = process.env): BusinessDeps {
  return {
    log: BusinessLog.fromEnv(env),
    badges: () => VerifiedSellerLog.fromEnv(env).all(),
    upheld: () => DecisionLog.fromEnv(env).upheldCounts(),
    resolveTxt: (name) => dns.resolveTxt(name),
    env,
    publish: businessPublisher(),
    plan: planChain(env),
  };
}
