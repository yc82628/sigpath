/** The real dependencies of the verification API: SigPath's logs and Solana. */

import { DecisionLog } from "../reports/reports";
import { CaseLog } from "../reports/cases";
import { publicFindings } from "../reports/seller";
import { VerifiedSellerLog } from "../sellers/verified-log";
import { BusinessLog } from "../sellers/business";
import { sellerSubject } from "../sellers/badges";
import { sasConfigFromEnv, signer } from "../chains/solana/sas";
import { readVerifiedSeller } from "../chains/solana/sas-verified";
import { readVerifiedBusiness } from "../chains/solana/sas-business";
import type { ApiDeps } from "./verification";

export function apiDepsFromEnv(env: Record<string, string | undefined> = process.env): ApiDeps {
  const cfg = sasConfigFromEnv();
  return {
    badges: () => VerifiedSellerLog.fromEnv(env).all(),
    businesses: () => BusinessLog.fromEnv(env).all(),
    upheld: () => DecisionLog.fromEnv(env).upheldCounts(),
    findings: (key) => publicFindings(key, { decisions: DecisionLog.fromEnv(env), cases: CaseLog.fromEnv(env) }),
    onChain: async (key) => (cfg ? readVerifiedSeller((await signer(cfg)).address, await sellerSubject(key), cfg.rpcUrl) : null),
    onChainBusiness: async (wallet) => (cfg ? readVerifiedBusiness((await signer(cfg)).address, wallet, cfg.rpcUrl) : null),
    baseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  };
}
