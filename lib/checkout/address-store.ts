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

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";
import { MAX_WINDOW_SECS } from "../chains/solana/orders";

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

interface StoredFile {
  v: 1;
  order: string;
  createdAt: number;
  iv: string;
  tag: string;
  ct: string;
}

export class AddressStore {
  private readonly dir: string;
  private readonly key: Buffer;

  private constructor(dir: string, key: Buffer) {
    this.dir = dir;
    this.key = key;
  }

  /** Null when ADDRESS_KEY is missing or malformed — the checkout then refuses to run. */
  static fromEnv(env: Record<string, string | undefined> = process.env): AddressStore | null {
    const raw = env.ADDRESS_KEY?.trim();
    if (!raw) return null;
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) return null;
    return new AddressStore(env.ADDRESS_STORE_DIR?.trim() || join(process.cwd(), ".data", "checkout"), key);
  }

  static withKey(dir: string, key: Buffer): AddressStore {
    if (key.length !== 32) throw new Error("ADDRESS_KEY must be 32 bytes.");
    return new AddressStore(dir, key);
  }

  /**
   * The ONLY way an order id becomes a filename. A base58 public key cannot
   * contain a path separator or "..", and re-encoding it through PublicKey
   * rejects anything that merely looks like one. Without this, "../../x" as an
   * order id is a path traversal.
   */
  private path(order: string): string {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(order)) throw new Error("Invalid order id.");
    const canonical = new PublicKey(order).toBase58();
    if (canonical !== order) throw new Error("Invalid order id.");
    return join(this.dir, `${canonical}.json`);
  }

  /** Write-once: an existing record for this order is never overwritten. */
  async put(order: string, record: OrderRecord, now = Date.now()): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(order, "utf8"));
    const ct = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
    const file: StoredFile = {
      v: 1,
      order,
      createdAt: Math.floor(now / 1000),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
    await mkdir(this.dir, { recursive: true });
    // "wx": fail if it exists. The order id is derived from a server-chosen
    // nonce, so a collision means something is wrong, and replacing the
    // address on an existing order would redirect someone's parcel.
    await writeFile(this.path(order), JSON.stringify(file), { flag: "wx", mode: 0o600 });
  }

  async get(order: string): Promise<{ record: OrderRecord; createdAt: number } | null> {
    let file: StoredFile;
    try {
      file = JSON.parse(await readFile(this.path(order), "utf8"));
    } catch {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(file.iv, "base64"));
    decipher.setAAD(Buffer.from(order, "utf8"));
    decipher.setAuthTag(Buffer.from(file.tag, "base64"));
    // Throws if the ciphertext, the tag, or the bound order id was altered.
    const pt = Buffer.concat([decipher.update(Buffer.from(file.ct, "base64")), decipher.final()]);
    return { record: JSON.parse(pt.toString("utf8")), createdAt: file.createdAt };
  }

  /** True if a record existed and is now gone. */
  async delete(order: string): Promise<boolean> {
    try {
      await unlink(this.path(order));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<{ order: string; createdAt: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: { order: string; createdAt: number }[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const f: StoredFile = JSON.parse(await readFile(join(this.dir, n), "utf8"));
        out.push({ order: f.order, createdAt: f.createdAt });
      } catch {
        /* a file that is not a record is not ours to judge; leave it */
      }
    }
    return out;
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
