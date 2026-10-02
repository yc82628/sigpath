/**
 * scripts/alerts-check.ts — run the price-drop checker.
 *
 *   npx tsx scripts/alerts-check.ts              one pass
 *   npx tsx scripts/alerts-check.ts --every 30   a pass every 30 minutes, until stopped
 *
 * Each distinct watched search runs once per pass; alerts fire only for new
 * SigPath-checked lows. Prints counts only — never a query or an endpoint.
 * On a host, schedule POST /api/alerts/run with ALERTS_CRON_SECRET instead.
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

async function pass() {
  const { runAlertCheck } = await import("../lib/alerts/api");
  const r = await runAlertCheck();
  const at = new Date().toISOString().slice(0, 16).replace("T", " ");
  if ("ok" in r) throw new Error(r.error);
  console.log(
    `${at}  watches ${r.watches} · searches ${r.searches} · alerted ${r.alerted} · expired ${r.expired} · unsubscribed ${r.gone}` +
      (r.errors.length ? ` · ${r.errors.length} error(s): ${r.errors.map((e) => e.replace(/^"[^"]*": /, "")).join("; ")}` : ""),
  );
}

async function main() {
  const i = process.argv.indexOf("--every");
  const minutes = i === -1 ? 0 : Number(process.argv[i + 1]);
  if (i !== -1 && !(minutes >= 5)) throw new Error("--every takes minutes, at least 5 (the marketplace APIs have daily quotas).");
  await pass();
  if (!minutes) return;
  for (;;) {
    await new Promise((r) => setTimeout(r, minutes * 60_000));
    await pass().catch((e) => console.error("ERROR:", e instanceof Error ? e.message : e));
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
