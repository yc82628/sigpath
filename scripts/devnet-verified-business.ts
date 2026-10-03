/**
 * scripts/devnet-verified-business.ts — prove the verified-business record, live.
 *
 *   npx tsx scripts/devnet-verified-business.ts
 *
 * Registers the verified-business schema (once per cluster), then for a
 * throwaway business wallet:
 *   - publishes the attestation and reads it back from the wallet alone
 *   - checks the VAT number against the on-chain hash, and that the hash
 *     reveals nothing without it (a wrong number doesn't match)
 *   - republishes with a website at the same address
 *   - confirms another wallet finds nothing
 *   - closes it (suspension): the address holds nothing, rent is returned
 *
 * Devnet only. The VAT number is a test value; nothing is checked against VIES.
 */

import { readFileSync } from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

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

async function main() {
  const { sasConfigFromEnv, signer } = await import("../lib/chains/solana/sas");
  const B = await import("../lib/chains/solana/sas-business");

  const cfg = sasConfigFromEnv();
  if (!cfg || !/devnet/.test(cfg.rpcUrl)) throw new Error("SAS must be configured on devnet.");
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const authority = (await signer(cfg)).address;
  const before = await conn.getBalance(new PublicKey(authority));
  console.log(`issuer ${authority.slice(0, 4)}…${authority.slice(-4)} · ${(before / 1e9).toFixed(4)} SOL`);
  if (before < 0.02e9) throw new Error("The issuer needs at least 0.02 devnet SOL.");

  console.log("\nschema");
  const s = await B.bootstrapBusinessSchema(cfg);
  check("verified-business schema registered (or already was)", s.status === "ok" || s.status === "exists", "reason" in s ? s.reason : s.attestation);

  const wallet = Keypair.generate().publicKey.toBase58();
  const nowS = Math.floor(Date.now() / 1000);
  const base = { wallet, country: "DE", vatNumber: "999999999", linkedAccounts: 2, verifiedAt: nowS, expiresAt: nowS + 365 * 86400 };
  console.log(`\nbusiness wallet ${wallet.slice(0, 4)}…${wallet.slice(-4)}`);

  const issued = await B.issueBusinessAttestation(cfg, base);
  check("attestation published", issued.status === "ok", issued.status === "ok" ? issued.explorer : issued.status === "error" ? issued.reason : "");
  await pause(1500);
  const read = await B.readVerifiedBusiness(authority, wallet, cfg.rpcUrl);
  check("read back from the wallet alone: valid", read.status === "valid");
  if (read.status === "valid") {
    check("country is DE", read.country === "DE");
    check("the VAT number matches its on-chain hash", read.vatHash === B.vatHash("DE", "999999999"));
    check("a different VAT number doesn't", read.vatHash !== B.vatHash("DE", "999999998"));
    check("the hash doesn't contain the number", !read.vatHash.includes("999999999"));
    check("no website yet", read.domainHash === null);
    check("two linked accounts", read.linkedAccounts === 2);
    check("expires in a year", Math.abs(read.expiresAt - base.expiresAt) <= 1);
    check("address is the one anyone derives from the wallet", read.attestation === (await B.businessAttestationAddress(authority, wallet)));
  }

  const again = await B.issueBusinessAttestation(cfg, { ...base, domain: "example-shop.de" });
  check("republished with a website", again.status === "ok", again.status === "error" ? again.reason : "");
  await pause(1500);
  const reread = await B.readVerifiedBusiness(authority, wallet, cfg.rpcUrl);
  check("same address, now with the website's hash", reread.status === "valid" && read.status === "valid" && reread.attestation === read.attestation && reread.domainHash === B.domainHash("example-shop.de"));

  const stranger = await B.readVerifiedBusiness(authority, Keypair.generate().publicKey.toBase58(), cfg.rpcUrl);
  check("another wallet finds nothing", stranger.status === "none");

  const closed = await B.revokeBusinessAttestation(cfg, wallet);
  check("closed on suspension", closed.status === "ok", closed.status === "error" ? closed.reason : "");
  await pause(1500);
  check("the address holds nothing afterwards", (await B.readVerifiedBusiness(authority, wallet, cfg.rpcUrl)).status === "none");
  check("closing again is a no-op, not an error", (await B.revokeBusinessAttestation(cfg, wallet)).status === "none");

  const after = await conn.getBalance(new PublicKey(authority));
  console.log(`\n${passed}/${passed + failed} passed · issuer spent ${((before - after) / 1e9).toFixed(6)} SOL (rent returned on close)`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
