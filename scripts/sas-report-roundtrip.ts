/**
 * scripts/sas-report-roundtrip.ts — prove the on-chain penalty, live.
 *
 *   npx tsx scripts/sas-report-roundtrip.ts
 *
 * Registers the fake-report schema (once per cluster), publishes two upheld
 * reports against a throwaway test seller, then counts them back using ONLY
 * the seller's handle and the issuer's public address — no keys, no local
 * files — which is exactly what any other app would do to check a seller.
 *
 * The seller handle is unique per run ("sigpath-demo-<timestamp>") on the
 * "stub" namespace, so this never writes anything about a real seller.
 * Devnet only: it refuses to run against mainnet.
 */

import { readFileSync } from "fs";

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
process.env.SAS_ENABLED = process.env.SAS_ENABLED ?? "true";

async function main() {
  const { sasConfigFromEnv, signer } = await import("../lib/chains/solana/sas");
  const { bootstrapReportSchema, countSellerReportsOnChain, reportAttestationAddress, deriveReportSchema } =
    await import("../lib/chains/solana/sas-reports");
  const { reportPublisher } = await import("../lib/reports/publish");
  const { subjectHash, bytesToHex } = await import("../lib/crypto/hash");
  const { createSolanaRpc } = await import("@solana/kit");
  const { fetchAttestation, fetchSchema, deserializeAttestationData } = await import("sas-lib");

  const cfg = sasConfigFromEnv();
  if (!cfg) throw new Error("SAS_ENABLED=true and ISSUER_SECRET are required.");
  if (!/devnet|127\.0\.0\.1|localhost/.test(cfg.rpcUrl)) throw new Error(`Refusing to write test reports to ${cfg.rpcUrl}.`);

  const authority = (await signer(cfg)).address;
  const { schema } = await deriveReportSchema(authority);
  console.log(`rpc        ${cfg.rpcUrl}`);
  console.log(`issuer     ${authority}`);
  console.log(`schema     ${schema}\n`);

  const boot = await bootstrapReportSchema(cfg);
  if (boot.status === "error" || boot.status === "disabled") throw new Error(boot.reason);
  console.log(`schema     ${boot.status === "exists" ? "already registered" : `registered, tx ${boot.signature}`}`);

  const seller = { source: "stub", handle: `sigpath-demo-${Date.now()}` };
  const subject = await subjectHash(seller.source, seller.handle);
  console.log(`seller     ${seller.source}:${seller.handle}`);
  console.log(`subject    ${bytesToHex(subject)}\n`);

  const before = await countSellerReportsOnChain(authority, subject, cfg.rpcUrl);
  console.log(`on chain before: ${before} upheld report(s)`);

  const publish = reportPublisher(cfg);
  const fake = (n: number) => ({
    order: `demo-order-${n}`,
    buyer: "not-published",
    seller,
    listing: { source: "stub", id: `demo-${n}`, url: `https://example.invalid/demo/${n}`, title: "demo", amount: 100, currency: "EUR" },
    category: n === 1 ? ("counterfeit" as const) : ("not_as_described" as const),
    description: "not-published",
    evidence: { imageBase64: "", mediaType: "image/jpeg", sha256: "ab".repeat(32), observed: "", confidence: 1 },
  });

  for (const n of [1, 2]) {
    const r = await publish(fake(n), 0, Math.floor(Date.now() / 1000));
    if ("error" in r) throw new Error(r.error);
    console.log(`published  report #${r.index}  ${r.attestation}`);
  }

  // The public read: nothing but the handle and the issuer's public address.
  const after = await countSellerReportsOnChain(authority, await subjectHash("stub", seller.handle.toUpperCase()), cfg.rpcUrl);
  console.log(`\non chain after (looked up by handle, different case): ${after} upheld report(s)`);

  const rpc = createSolanaRpc(cfg.rpcUrl);
  const first = await fetchAttestation(rpc, await reportAttestationAddress(authority, subject, 0));
  const decoded = deserializeAttestationData((await fetchSchema(rpc, schema)).data, first.data.data as Uint8Array) as Record<string, unknown>;
  console.log(`\nreport #0 decoded from chain:`);
  for (const [k, v] of Object.entries(decoded)) console.log(`  ${k.padEnd(14)} ${String(v)}`);
  console.log(`  expiry         ${first.data.expiry === 0n ? "never" : String(first.data.expiry)}`);

  if (after !== before + 2) throw new Error(`expected ${before + 2}, counted ${after}`);

  // --- reversal: report #1 overturned on appeal --------------------------------
  const { reversalPublisher } = await import("../lib/reports/publish");
  const { sellerFindingsOnChain } = await import("../lib/chains/solana/sas-reports");
  const { sellerKey } = await import("../lib/marketplace/types");

  const rev = await reversalPublisher(cfg)(
    { sellerKey: sellerKey(seller.source, seller.handle), index: 1, attestation: "published" } as never,
    Math.floor(Date.now() / 1000),
  );
  if ("error" in rev) throw new Error(rev.error);
  console.log(`\nreversed   report #1  ${rev.attestation}`);

  const again = await reversalPublisher(cfg)(
    { sellerKey: sellerKey(seller.source, seller.handle), index: 1, attestation: "published" } as never,
    Math.floor(Date.now() / 1000),
  );
  console.log(`reverse #1 twice: ${"error" in again ? `refused (${again.error})` : "ACCEPTED — should not be"}`);

  const bogus = await reversalPublisher(cfg)(
    { sellerKey: sellerKey(seller.source, seller.handle), index: 7, attestation: "published" } as never,
    Math.floor(Date.now() / 1000),
  );
  console.log(`reverse #7 (never issued): ${"error" in bogus ? `refused (${bogus.error})` : "ACCEPTED — should not be"}`);

  const f = await sellerFindingsOnChain(authority, subject, cfg.rpcUrl);
  console.log(`\nfrom the handle alone: ${f.upheld} upheld, reversed [${f.reversed.map((i) => `#${i}`).join(", ")}], ACTIVE ${f.active}`);
  // Each refusal must be refused for ITS reason. "Any error" would also be
  // satisfied by an RPC rate limit — which is exactly what happened the first
  // time this ran, and would have passed a broken safeguard.
  const refusedFor = (r: { error: string } | { attestation: string }, re: RegExp) => "error" in r && re.test(r.error);
  if (
    f.active !== 1 ||
    f.reversed.join() !== "1" ||
    !refusedFor(again, /already been reversed/) ||
    !refusedFor(bogus, /no report #7/)
  ) {
    throw new Error("reversal did not behave as specified");
  }
  console.log("\nON-CHAIN PENALTY AND REVERSAL WORK — readable from the handle alone");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
