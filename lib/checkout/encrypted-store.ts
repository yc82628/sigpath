/**
 * lib/checkout/encrypted-store.ts — one encrypted file per order, done once.
 *
 * Three things now need "personal data about an order, encrypted at rest,
 * deletable": delivery addresses, which seller an order bought from, and
 * fake-product reports. One implementation of the crypto and the path safety,
 * rather than three copies that drift — the copy nobody is looking at is the
 * one that ends up missing its authentication tag check.
 *
 * WHAT EVERY STORE GETS
 *   - AES-256-GCM, key from the environment, never on disk beside the data
 *   - the record bound to its order AND its purpose as additional
 *     authenticated data: a file renamed onto another order will not decrypt,
 *     and neither will a file copied from one store into another, even though
 *     they share a key
 *   - write-once: an existing record is never overwritten
 *   - order ids validated as canonical base58 before they touch a path, so an
 *     id can never be "../../something"
 *   - only the creation time in the clear, so retention can be enforced even
 *     when the key is unavailable
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";

interface StoredFile {
  v: 1;
  order: string;
  createdAt: number;
  iv: string;
  tag: string;
  ct: string;
}

export class EncryptedStore<T> {
  constructor(
    protected readonly dir: string,
    private readonly key: Buffer,
    /**
     * Mixed into the authenticated data. Empty for the address store, which
     * predates this class and must keep decrypting its existing records;
     * every newer store names itself.
     */
    private readonly purpose: string,
  ) {
    if (key.length !== 32) throw new Error("Store key must be 32 bytes.");
  }

  private aad(order: string): Buffer {
    return Buffer.from(this.purpose ? `${this.purpose}:${order}` : order, "utf8");
  }

  /**
   * The ONLY way an order id becomes a filename. A base58 public key cannot
   * contain a path separator or "..", and re-encoding it through PublicKey
   * rejects anything that merely looks like one.
   */
  protected path(order: string): string {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(order)) throw new Error("Invalid order id.");
    const canonical = new PublicKey(order).toBase58();
    if (canonical !== order) throw new Error("Invalid order id.");
    return join(this.dir, `${canonical}.json`);
  }

  /** Write-once: an existing record for this order is never overwritten. */
  async put(order: string, record: T, now = Date.now()): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(order));
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
    // "wx": fail if it exists.
    await writeFile(this.path(order), JSON.stringify(file), { flag: "wx", mode: 0o600 });
  }

  async get(order: string): Promise<{ record: T; createdAt: number } | null> {
    let file: StoredFile;
    try {
      file = JSON.parse(await readFile(this.path(order), "utf8"));
    } catch {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(file.iv, "base64"));
    decipher.setAAD(this.aad(order));
    decipher.setAuthTag(Buffer.from(file.tag, "base64"));
    // Throws if the ciphertext, the tag, the order id or the purpose differs.
    const pt = Buffer.concat([decipher.update(Buffer.from(file.ct, "base64")), decipher.final()]);
    return { record: JSON.parse(pt.toString("utf8")), createdAt: file.createdAt };
  }

  async has(order: string): Promise<boolean> {
    try {
      await readFile(this.path(order), "utf8");
      return true;
    } catch {
      return false;
    }
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
        if (f.v === 1 && typeof f.order === "string") out.push({ order: f.order, createdAt: f.createdAt });
      } catch {
        /* a file that is not a record is not ours to judge; leave it */
      }
    }
    return out;
  }
}

/** Read a 32-byte base64 key from the environment, or null. */
export function keyFromEnv(env: Record<string, string | undefined>, name = "ADDRESS_KEY"): Buffer | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}
