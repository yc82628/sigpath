/**
 * scripts/orders-admin.ts — the operator's side of USDC checkout.
 *
 *   npx tsx scripts/orders-admin.ts list                 orders awaiting you (no addresses)
 *   npx tsx scripts/orders-admin.ts show <order>         one order, WITH its delivery address
 *   npx tsx scripts/orders-admin.ts fulfil <order> <retailer-reference>
 *   npx tsx scripts/orders-admin.ts refund <order>       refund early (item unavailable)
 *   npx tsx scripts/orders-admin.ts sweep                delete addresses no longer needed
 *
 * THE WORKFLOW
 *   1. `list` shows paid orders and how long you have left on each.
 *   2. `show` gives you the item link and where to send it. Buy it on the
 *      retailer's site, shipping to that address.
 *   3. `fulfil` with the retailer's order number. That pays you from escrow,
 *      commits a hash of the reference on chain, and DELETES the address.
 *
 * `list` deliberately prints no addresses: a routine overview should not put
 * personal data on screen. Only `show` decrypts one, for the order you are
 * about to buy.
 *
 * Signs as the operator with ISSUER_SECRET from .env.local.
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

function hoursLeft(deadline: number): string {
  const s = deadline - Math.floor(Date.now() / 1000);
  if (s <= 0) return "DEADLINE PASSED — refund is open";
  const h = Math.floor(s / 3600);
  return h >= 48 ? `${Math.floor(h / 24)} days left` : `${h}h ${Math.floor((s % 3600) / 60)}m left`;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { AddressStore } = await import("../lib/checkout/address-store");
  const { chainStatusReader, ordersRpcUrl, readOrder } = await import("../lib/checkout/checkout");
  const { fulfilOrder, refundOrderAsOperator } = await import("../lib/checkout/operator");
  const { formatUsdc } = await import("../lib/chains/solana/orders");
  const { formatMoney } = await import("../lib/marketplace/types");

  const store = AddressStore.fromEnv();
  if (!store) throw new Error("ADDRESS_KEY is not set in .env.local — there is no address store to read.");
  const conn = new Connection(ordersRpcUrl(), "confirmed");
  console.log(`rpc  ${ordersRpcUrl()}\n`);

  const operator = () => {
    const secret = process.env.ISSUER_SECRET;
    if (!secret) throw new Error("ISSUER_SECRET (the operator key) is not set.");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  };

  switch (cmd) {
    case "list": {
      const records = await store.list();
      if (!records.length) {
        console.log("No orders awaiting fulfilment.");
        return;
      }
      for (const { order } of records) {
        const state = await readOrder(conn, new PublicKey(order)).catch(() => null);
        const got = await store.get(order).catch(() => null);
        const title = got?.record.listing.title ?? "(record unreadable)";
        if (!state || !state.found) {
          console.log(`${order}\n   not on chain yet (checkout started, not paid)  ${title}\n`);
          continue;
        }
        console.log(`${order}\n   ${state.status.padEnd(9)} ${formatUsdc(state.amount).padEnd(14)} ${hoursLeft(state.deadline)}\n   ${title}\n`);
      }
      return;
    }

    case "show": {
      const order = args[0];
      if (!order) throw new Error("Usage: show <order>");
      const got = await store.get(order);
      if (!got) throw new Error("No stored record for that order (never existed, or already deleted).");
      const state = await readOrder(conn, new PublicKey(order));
      const { record } = got;
      console.log(`order     ${order}`);
      console.log(`status    ${state.found ? state.status : "not on chain"}${state.found ? `  (${hoursLeft(state.deadline)})` : ""}`);
      console.log(`paid      ${state.found ? formatUsdc(state.amount) : "-"}`);
      console.log(`item      ${record.listing.title}`);
      console.log(`          ${record.listing.url}`);
      console.log(`quoted    ${formatMoney({ amount: record.listing.amount, currency: record.listing.currency })} (${record.listing.source})`);
      console.log(`\nship to   ${record.address.name}`);
      console.log(`          ${record.address.line1}`);
      if (record.address.line2) console.log(`          ${record.address.line2}`);
      console.log(`          ${record.address.postcode} ${record.address.city}`);
      console.log(`          ${record.address.country}`);
      console.log(`\nAfter buying:  npx tsx scripts/orders-admin.ts fulfil ${order} <retailer order number>`);
      return;
    }

    case "fulfil": {
      const [order, ...refParts] = args;
      const reference = refParts.join(" ");
      if (!order || !reference) throw new Error("Usage: fulfil <order> <retailer-reference>");
      const r = await fulfilOrder(conn, operator(), new PublicKey(order), reference, store);
      console.log(`fulfilled   tx ${r.signature}`);
      console.log(`address     ${r.addressDeleted ? "deleted" : "was not stored (nothing to delete)"}`);
      return;
    }

    case "refund": {
      const order = args[0];
      if (!order) throw new Error("Usage: refund <order>");
      const r = await refundOrderAsOperator(conn, operator(), new PublicKey(order), store);
      console.log(`refunded    tx ${r.signature}`);
      console.log(`address     ${r.addressDeleted ? "deleted" : "was not stored (nothing to delete)"}`);
      return;
    }

    case "sweep": {
      const deleted = await store.sweep(chainStatusReader(conn));
      if (!deleted.length) console.log("Nothing to delete.");
      for (const d of deleted) console.log(`deleted  ${d.order}  (${d.reason})`);
      return;
    }

    default:
      console.error("Usage: orders-admin.ts list | show <order> | fulfil <order> <ref> | refund <order> | sweep");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
