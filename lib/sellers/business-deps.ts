/** The real dependencies of the business steps: the logs on disk, DNS, the network. */

import { promises as dns } from "dns";
import { DecisionLog } from "../reports/reports";
import { VerifiedSellerLog } from "./verified-log";
import { BusinessLog } from "./business";
import type { BusinessDeps } from "./business-api";
import { businessPublisher } from "./business-chain";

export function businessDepsFromEnv(env: Record<string, string | undefined> = process.env): BusinessDeps {
  return {
    log: BusinessLog.fromEnv(env),
    badges: () => VerifiedSellerLog.fromEnv(env).all(),
    upheld: () => DecisionLog.fromEnv(env).upheldCounts(),
    resolveTxt: (name) => dns.resolveTxt(name),
    env,
    publish: businessPublisher(),
  };
}
