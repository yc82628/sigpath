/**
 * lib/checkout/address-store.ts — shipping addresses, encrypted, and deleted.
 *
 * WHY THIS EXISTS AT ALL
 * SigPath buys the item on the shopper's behalf, so it has to know where to
 * send it. That makes SigPath responsible for personal data under the GDPR, in
 * a product whose whole stance is "nothing stored about you". The way to square
 * that is to collect only what delivery needs, hold it only as long as delivery
 * needs, and make the deletion mechanical rather than a good intention.
 *
 * WHAT IS STORED
 * One file per order, named by the order's on-chain address. Everything in it
 * that could identify a person — the address, and the wallet that paid — is
 * encrypted with AES-256-GCM under ADDRESS_KEY. The order address is bound in
 * as additional authenticated data, so a record cannot be copied onto a
 * different order: decryption fails if the file is renamed.
 *
 * Only the creation time is stored in the clear, because retention has to be
 * enforceable even if the key is unavailable.
 *
 * WHEN IT IS DELETED
 *   - when the operator fulfils the order (scripts/orders-admin.ts deletes it
 *     right after the fulfil transaction confirms)
 *   - when the order is refunded, or the checkout was abandoned and the order
 *     never appeared on chain — found by sweep(), which runs on every checkout
 *     request and from the admin script
 *   - UNCONDITIONALLY once older than the longest possible order window, even
 *     if the chain cannot be read. That cap is the backstop that makes "we
 *     delete it" true rather than usually true.
 *
 * Deletion removes the file. It does not scrub the disk sectors; a production
 * deployment would keep this in a database with its own erasure guarantees.
 *
 * THE ORDER ADDRESS IS PUBLIC, THE SHIPPING ADDRESS IS NOT
 * Order accounts are readable by anyone. Nothing here is ever served by the
 * public order page — only the operator tooling reads a record back.
 */

import { join } from "path";
import { MAX_WINDOW_SECS } from "../chains/solana/orders";
import { EncryptedStore, backendFromEnv, keyFromEnv } from "./encrypted-store";
import { dataDir } from "../data-dir";

/** A checkout that never reached the chain is forgotten after this. */
export const PENDING_TTL_SECONDS = 15 * 60;
/** Nothing survives longer than the longest order window plus a day's grace. */
export const RETENTION_MAX_SECONDS = MAX_WINDOW_SECS + 24 * 3600;

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  postcode: string;
  city: string;
  /** ISO 3166-1 alpha-2, e.g. "DE". */
  country: string;
}

export interface OrderRecord {
  address: ShippingAddress;
  /** The wallet that paid. Personal data once linked to an address. */
  buyer: string;
  listing: { source: string; id: string; url: string; title: string; amount: number; currency: string };
  usdc: string;
}

// ---------------------------------------------------------------------------
// Validation — data minimisation starts at the form
// ---------------------------------------------------------------------------

const LIMITS: Record<keyof ShippingAddress, [number, number]> = {
  name: [1, 100],
  line1: [1, 200],
  line2: [0, 200],
  postcode: [1, 20],
  city: [1, 100],
  country: [2, 2],
};

/**
 * Accept exactly the fields delivery needs, and nothing else. Unknown fields
 * are dropped rather than stored: a form that gains an "email" or "phone"
 * input later does not silently start keeping it.
 */
export function validateAddress(input: unknown): { ok: true; address: ShippingAddress } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Address is required." };
  const raw = input as Record<string, unknown>;
  const out: Partial<ShippingAddress> = {};

  for (const key of Object.keys(LIMITS) as (keyof ShippingAddress)[]) {
    const v = raw[key];
    const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    const [min, max] = LIMITS[key];
    if (!s) {
      // An optional field left blank is omitted entirely, not stored as "".
      if (min === 0) continue;
      return { ok: false, error: `${key} is required.` };
    }
    if (s.length < min) return { ok: false, error: `${key} is too short.` };
    if (s.length > max) return { ok: false, error: `${key} is too long.` };
    out[key] = key === "country" ? s.toUpperCase() : s;
  }
  if (!/^[A-Z]{2}$/.test(out.country!)) return { ok: false, error: "country must be a two-letter code, e.g. DE." };
  return { ok: true, address: out as ShippingAddress };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Delivery addresses. The encryption, write-once rule and path safety live in
 * EncryptedStore; this adds the retention policy that is specific to them.
 *
 * Purpose is "" so the authenticated data is the bare order id, exactly as
 * before the shared store existed — records written then still decrypt.
 */
export class AddressStore extends EncryptedStore<OrderRecord> {
  /** Null when ADDRESS_KEY is missing or malformed — the checkout then refuses to run. */
  static fromEnv(env: Record<string, string | undefined> = process.env): AddressStore | null {
    const key = keyFromEnv(env);
    if (!key) return null;
    const backend = backendFromEnv(env, {
      explicitDir: env.ADDRESS_STORE_DIR,
      defaultDir: join(dataDir(env), "checkout"),
      namespace: "checkout",
      ttlSecs: RETENTION_MAX_SECONDS,
    });
    return new AddressStore(backend, key, "");
  }

  static withKey(dir: string, key: Buffer): AddressStore {
    if (key.length !== 32) throw new Error("ADDRESS_KEY must be 32 bytes.");
    return new AddressStore(dir, key, "");
  }

  /**
   * Delete every record that no longer needs to exist.
   *
   * `orderStatus` reads the chain: "funded", "fulfilled", "refunded", "missing"
   * (no order account), or "unknown" (the chain could not be read). Only the
   * retention cap applies to "unknown" — an RPC outage must not delete an
   * address the operator still needs, and must not keep one forever either.
   */
  async sweep(
    orderStatus: (order: string) => Promise<"funded" | "fulfilled" | "refunded" | "missing" | "unknown">,
    now = Date.now(),
  ): Promise<{ order: string; reason: string }[]> {
    const nowS = Math.floor(now / 1000);
    const deleted: { order: string; reason: string }[] = [];

    for (const { order, createdAt } of await this.list()) {
      const age = nowS - createdAt;
      let reason: string | null = null;

      if (age > RETENTION_MAX_SECONDS) {
        reason = "retention limit reached";
      } else {
        const status = await orderStatus(order);
        if (status === "fulfilled" || status === "refunded") reason = `order ${status}`;
        else if (status === "missing" && age > PENDING_TTL_SECONDS) reason = "checkout abandoned";
      }

      if (reason && (await this.delete(order))) deleted.push({ order, reason });
    }
    return deleted;
  }
}
