/**
 * scripts/sas-read.ts — read a SigPath credential back out of SAS.
 *
 * This is the half that matters. Issuing a credential proves nothing on its
 * own; what makes SAS worth using over a private database is that somebody
 * else can find and decode the record knowing only the subject and the
 * issuer's public address.
 *
 *   npx tsx scripts/sas-read.ts github alice
 *
 * Nothing secret is used to read. ISSUER_SECRET is loaded only to derive the
 * issuer's public address — pass --authority <address> to skip it entirely and
 * see that this works with no access to our keys at all.
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

const METHOD_BITS: [number, string][] = [
  [1 << 0, "SELF_ASSERTED"],
  [1 << 1, "OWNERSHIP_PROVEN"],
  [1 << 2, "CORROBORATED"],
  [1 << 3, "LIVE_CAPTURE"],
];

function describeMethod(method: number): string {
  const set = METHOD_BITS.filter(([bit]) => (method & bit) !== 0).map(([, name]) => name);
  return set.length ? set.join(" | ") : "none";
}

async function main() {
  const args = process.argv.slice(2);
  const authorityFlag = args.indexOf("--authority");
  let authorityArg: string | undefined;
  if (authorityFlag !== -1) {
    authorityArg = args[authorityFlag + 1];
    args.splice(authorityFlag, 2);
  }

  const [platform, handle] = args;
  if (!platform || !handle) {
    console.error("Usage: npx tsx scripts/sas-read.ts <platform> <handle> [--authority <address>]");
    console.error("  e.g. npx tsx scripts/sas-read.ts github alice");
    process.exit(1);
  }

  const { readSasAttestation, deriveSubjectAttestation } = await import("../lib/chains/solana/sas");
  const { subjectHash, bytesToHex } = await import("../lib/crypto/hash");
  const { createKeyPairSignerFromBytes, address } = await import("@solana/kit");

  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

  let authority;
  if (authorityArg) {
    authority = address(authorityArg);
  } else {
    const raw = process.env.ISSUER_SECRET;
    if (!raw) {
      console.error("Set ISSUER_SECRET in .env.local, or pass --authority <address>.");
      process.exit(1);
    }
    authority = (await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(raw)))).address;
  }

  // Everything below is derived from PUBLIC inputs: the issuer address and the
  // subject. No lookup table, no API call to SigPath.
  const subject = await subjectHash(platform, handle);
  const { attestation } = await deriveSubjectAttestation(authority, subject);

  console.log(`rpc          ${rpcUrl}`);
  console.log(`issuer       ${authority}`);
  console.log(`subject      ${platform}:${handle}`);
  console.log(`hash         ${bytesToHex(subject)}`);
  console.log(`attestation  ${attestation}`);
  console.log("");

  const res = await readSasAttestation(authority, subject, rpcUrl);

  if (res.status === "not_found") {
    console.log("NOT FOUND — no SAS attestation exists for this subject.");
    console.log("Absence is not a negative verdict. It means nobody has verified this handle.");
    process.exit(3);
  }
  if (res.status === "error") {
    console.error(`ERROR: ${res.reason}`);
    process.exit(1);
  }

  const score = Number(res.data.score);
  const method = Number(res.data.method);
  const issuedAt = Number(res.data.issuedAt);

  console.log(`score        ${score} / 100`);
  console.log(`method       ${method}  (${describeMethod(method)})`);
  console.log(`issued       ${new Date(issuedAt * 1000).toISOString()}`);
  console.log(
    `expiry       ${res.expiry ? new Date(res.expiry * 1000).toISOString() : "never"}` +
      (res.expired ? "   ** EXPIRED **" : ""),
  );
  console.log(`signer       ${res.signer}`);
  console.log(`explorer     ${res.explorer}`);

  // The distinction a consumer actually has to act on.
  console.log("");
  if (res.expired) {
    console.log("STALE — this verification has expired. Expired is not revoked, and not failed.");
    console.log("It means the evidence is old enough that it no longer says much.");
  } else if ((method & 0b0100) === 0) {
    console.log("PRESENT but UNCORROBORATED — nothing here was checked against a third party.");
  } else {
    console.log("VALID — corroborated, unexpired, signed by the issuer above.");
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
