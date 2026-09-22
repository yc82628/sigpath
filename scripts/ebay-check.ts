/**
 * scripts/ebay-check.ts — prove an eBay keyset works, in isolation.
 *
 *   npx tsx scripts/ebay-check.ts "thinkpad x1"
 *
 * Run this BEFORE wiring anything else. It separates the three things that can
 * go wrong — credentials, the token exchange, and the search call — so a
 * failure names which one it was, instead of surfacing as an empty result page
 * with no explanation.
 *
 * It reads .env.local, calls the real API once, and writes nothing.
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

async function main() {
  const query = process.argv.slice(2).join(" ") || "thinkpad x1";

  const { EbaySource } = await import("../lib/marketplace/sources/ebay");
  const { formatMoney, totalPrice } = await import("../lib/marketplace/types");

  const env = (process.env.EBAY_ENV || "production").toLowerCase();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_DE";

  console.log(`environment  ${env}`);
  console.log(`marketplace  ${marketplace}`);
  console.log(`client id    ${process.env.EBAY_CLIENT_ID ? "set" : "MISSING"}`);
  console.log(`secret       ${process.env.EBAY_CLIENT_SECRET ? "set" : "MISSING"}`);
  console.log(`query        ${query}\n`);

  const started = Date.now();
  const res = await new EbaySource().search(query, { limit: 5 });
  const ms = Date.now() - started;

  if (res.status !== "ok") {
    console.error(`FAILED  status=${res.status}`);
    console.error(res.detail ?? "(no detail)");
    console.error("");
    if (res.status === "not_configured") {
      console.error("Add to .env.local:");
      console.error("  EBAY_CLIENT_ID=<App ID from the Application Keys page>");
      console.error("  EBAY_CLIENT_SECRET=<Cert ID from the same row>");
      console.error("  EBAY_ENV=sandbox        # or production");
    } else {
      console.error("Most likely causes, in order:");
      console.error("  1. A PRODUCTION keyset that has not been enabled yet. New production");
      console.error("     keysets are disabled until the marketplace account deletion");
      console.error("     notification step is completed on the Application Keys page.");
      console.error("  2. Sandbox keys with EBAY_ENV unset (it defaults to production).");
      console.error("  3. App ID and Cert ID swapped, or whitespace pasted with them.");
    }
    process.exit(1);
  }

  console.log(`OK  ${res.listings.length} listing(s) in ${ms} ms`);
  if (res.detail) console.log(`NOTE  ${res.detail}`);
  console.log("");

  for (const l of res.listings) {
    console.log(`  ${formatMoney(totalPrice(l)).padStart(12)}  ${l.condition.padEnd(11)} ${l.title.slice(0, 60)}`);
    console.log(`  ${" ".repeat(12)}  seller ${l.seller.handle}` +
      (l.seller.feedbackScore !== undefined ? ` (${l.seller.feedbackScore} ratings)` : ""));
  }

  if (!res.listings.length) {
    console.log("  (the call succeeded but matched nothing — try a broader query)");
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
