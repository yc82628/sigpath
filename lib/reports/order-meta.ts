/**
 * lib/reports/order-meta.ts — which seller an order bought from.
 *
 * WHY THIS EXISTS
 * A fake-product report is only a penalty if it lands on the right seller. But
 * by the time a buyer can report — after the item arrives — SigPath had
 * forgotten who the seller was: the on-chain order holds only a hash of the
 * listing, and the delivery record (which had the listing) is deleted at
 * fulfilment, by design. So checkout now keeps a second, narrower record: the
 * listing and the seller, for exactly as long as a report could still be filed.
 *
 * IT IS STILL PERSONAL DATA
 * It links a wallet to a purchase, so it is encrypted like the address, under
 * its own purpose tag (a record copied from the address store will not decrypt
 * here), and deleted on a schedule rather than kept "in case".
 *
 * RETENTION
 *   - refunded: deleted — the buyer has their money back, there is nothing to report
 *   - never paid: deleted after the pending window, like an abandoned address
 *   - fulfilled: kept for REPORT_WINDOW_SECS after settlement, then deleted
 *   - always: deleted past the longest order window plus the report window,
 *     even if the chain cannot be read
 */

import { join } from "path";
import { MAX_WINDOW_SECS } from "../chains/solana/orders";
import { EncryptedStore, keyFromEnv } from "../checkout/encrypted-store";
import { PENDING_TTL_SECONDS } from "../checkout/address-store";

/** How long after fulfilment a buyer may report what arrived. */
export const REPORT_WINDOW_SECS = 30 * 24 * 3600;

/** Absolute cap: nothing survives the longest order plus the report window, plus a day. */
export const ORDER_META_RETENTION_SECS = MAX_WINDOW_SECS + REPORT_WINDOW_SECS + 24 * 3600;

export interface OrderMeta {
  buyer: string;
  seller: { source: string; handle: string };
  listing: { source: string; id: string; url: string; title: string; amount: number; currency: string };
}

export type ChainOrderView =
  | { status: "funded" | "fulfilled" | "refunded"; settledAt: number }
  | "missing"
  | "unknown";

export class OrderMetaStore extends EncryptedStore<OrderMeta> {
  static fromEnv(env: Record<string, string | undefined> = process.env): OrderMetaStore | null {
    const key = keyFromEnv(env);
    if (!key) return null;
    return new OrderMetaStore(env.ORDER_META_DIR?.trim() || join(process.cwd(), ".data", "order-meta"), key, "order-meta");
  }

  static withKey(dir: string, key: Buffer): OrderMetaStore {
    return new OrderMetaStore(dir, key, "order-meta");
  }

  async sweep(view: (order: string) => Promise<ChainOrderView>, now = Date.now()) {
    const nowS = Math.floor(now / 1000);
    const deleted: { order: string; reason: string }[] = [];

    for (const { order, createdAt } of await this.list()) {
      const age = nowS - createdAt;
      let reason: string | null = null;

      if (age > ORDER_META_RETENTION_SECS) {
        reason = "retention limit reached";
      } else {
        const v = await view(order);
        if (v === "missing") {
          if (age > PENDING_TTL_SECONDS) reason = "checkout abandoned";
        } else if (v !== "unknown") {
          if (v.status === "refunded") reason = "order refunded";
          else if (v.status === "fulfilled" && nowS > v.settledAt + REPORT_WINDOW_SECS) reason = "report window closed";
        }
      }

      if (reason && (await this.delete(order))) deleted.push({ order, reason });
    }
    return deleted;
  }
}
