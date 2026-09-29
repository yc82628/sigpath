/**
 * lib/reports/evidence.ts — the pieces the report routes share.
 *
 * The evidence verifier is its own VisionLivenessProvider, issued for the
 * "evidence" subject only. It shares nothing with the identity check except the
 * vision backend: sessions it issues are refused by the identity route, and
 * identity sessions are refused here (see ChallengeSubject in generate.ts).
 *
 * It is always the vision provider, whatever LIVENESS_PROVIDER says. The mock
 * provider passes everything, and a report whose evidence nobody checked is
 * exactly the false report this whole design exists to keep out.
 */

import { Connection } from "@solana/web3.js";
import { VisionLivenessProvider } from "../liveness/vision";
import { ordersRpcUrl } from "../checkout/checkout";
import { OrderMetaStore } from "./order-meta";
import { DecisionLog, ReportStore, type ReportDeps } from "./reports";

let provider: VisionLivenessProvider | null = null;

export function evidenceProvider(): VisionLivenessProvider {
  provider ??= new VisionLivenessProvider("evidence");
  return provider;
}

/** Null when ADDRESS_KEY is missing — without it there is nowhere safe to keep evidence. */
export function reportDepsFromEnv(env: Record<string, string | undefined> = process.env): ReportDeps | null {
  const metaStore = OrderMetaStore.fromEnv(env);
  const reportStore = ReportStore.fromEnv(env);
  if (!metaStore || !reportStore) return null;
  return {
    conn: new Connection(ordersRpcUrl(env), "confirmed"),
    metaStore,
    reportStore,
    decisions: DecisionLog.fromEnv(env),
  };
}
