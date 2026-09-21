/**
 * scripts/sas-bootstrap.ts — register the SigPath credential and schema on SAS.
 *
 * Run ONCE per cluster. A second run fails with "already in use", which is
 * harmless but wastes a fee.
 *
 *   SAS_ENABLED=true npx tsx scripts/sas-bootstrap.ts
 *   SAS_ENABLED=true npx tsx scripts/sas-bootstrap.ts --issue   (also issue a test attestation)
 *
 * The addresses it prints are deterministic from the issuer authority, so you
 * do not need to record them anywhere — they can always be re-derived.
 */

import { readFileSync } from "fs";

function loadEnv(path = ".env.local") {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
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
  const {
    sasConfigFromEnv,
    bootstrapSasIssuer,
    deriveSigPathAddresses,
    deriveSubjectAttestation,
    issueSasAttestation,
    SAS_PROGRAM_ID,
  } = await import("../lib/chains/solana/sas");
  const { subjectHash, bytesToHex } = await import("../lib/crypto/hash");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");

  const cfg = sasConfigFromEnv();
  if (!cfg) {
    console.error("SAS disabled or ISSUER_SECRET missing. Set SAS_ENABLED=true in .env.local.");
    process.exit(1);
  }

  const authority = await createKeyPairSignerFromBytes(cfg.secretKey);
  const { credential, schema } = await deriveSigPathAddresses(authority.address);

  console.log(`rpc         ${cfg.rpcUrl}`);
  console.log(`sas program ${SAS_PROGRAM_ID}`);
  console.log(`authority   ${authority.address}`);
  console.log(`credential  ${credential}`);
  console.log(`schema      ${schema}\n`);

  console.log("registering credential + schema…");
  const boot = await bootstrapSasIssuer(cfg);
  if (boot.status === "ok") {
    console.log(`  ok   tx ${boot.signature}`);
    console.log(`       ${boot.explorer}`);
  } else if (boot.status === "error" && /already in use/i.test(boot.reason)) {
    console.log("  already registered — continuing");
  } else {
    console.error(`  FAILED: ${"reason" in boot ? boot.reason : "unknown"}`);
    process.exit(1);
  }

  if (!process.argv.includes("--issue")) {
    console.log("\nPass --issue to also write a test attestation.");
    return;
  }

  // A unique subject per run so repeat runs do not collide on an existing PDA.
  const handle = `sas-test-${Date.now()}`;
  const subject = await subjectHash("github", handle);
  const { attestation } = await deriveSubjectAttestation(authority.address, subject);

  console.log(`\nsubject     github:${handle}`);
  console.log(`hash        ${bytesToHex(subject)}`);
  console.log(`attestation ${attestation}`);
  console.log("issuing…");

  const expiry = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
  const res = await issueSasAttestation(subject, 64, 0b0110, expiry, cfg);

  if (res.status === "ok") {
    console.log(`  ok   tx ${res.signature}`);
    console.log(`       ${res.explorer}`);
    console.log("\nSAS ISSUANCE WORKS");
  } else {
    console.error(`  FAILED: ${"reason" in res ? res.reason : "unknown"}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
