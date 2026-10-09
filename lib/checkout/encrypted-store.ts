/**
 * lib/checkout/encrypted-store.ts — one encrypted record per order, done once.
 *
 * Three things now need "personal data about an order, encrypted at rest,
 * deletable": delivery addresses, which seller an order bought from, and
 * fake-product reports. One implementation of the crypto and the path safety,
 * rather than three copies that drift — the copy nobody is looking at is the
 * one that ends up missing its authentication tag check.
 *
 * WHAT EVERY STORE GETS
 *   - AES-256-GCM, key from the environment, never stored beside the data
 *   - the record bound to its order AND its purpose as additional
 *     authenticated data: a record moved onto another order will not decrypt,
 *     and neither will one copied from one store into another, even though
 *     they share a key
 *   - write-once: an existing record is never overwritten
 *   - order ids validated as canonical base58 before they become a file name
 *     or a database key, so an id can never be "../../something"
 *   - only the creation time in the clear, so retention can be enforced even
 *     when the key is unavailable
 *
 * WHERE THE RECORDS LIVE
 * In the shared database (lib/kv/upstash.ts) when one is configured, which is
 * what a deployment on Vercel needs: its disk is temporary and per instance.
 * Otherwise one file per order, as before (tests, and running without a
 * database). Either way the backend only ever sees the encrypted record. In
 * the database each record also expires at its store's retention limit: if
 * every sweep failed, the database would still delete it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";
import { UpstashKv, type Kv } from "../kv/upstash";

interface StoredFile {
  v: 1;
  order: string;
  createdAt: number;
  iv: string;
  tag: string;
  ct: string;
}

/** Where encrypted records are kept. Sees ciphertext only; ids arrive validated. */
export interface RecordBackend {
  /** False if a record already exists for this id (write-once). */
  putIfAbsent(id: string, value: string): Promise<boolean>;
  get(id: string): Promise<string | null>;
  /** True if a record existed and is now gone. */
  delete(id: string): Promise<boolean>;
  list(): Promise<{ id: string; value: string }[]>;
}

/** One file per order. */
export class FileBackend implements RecordBackend {
  constructor(readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async putIfAbsent(id: string, value: string): Promise<boolean> {
    await mkdir(this.dir, { recursive: true });
    try {
      // "wx": fail if it exists.
      await writeFile(this.file(id), value, { flag: "wx", mode: 0o600 });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  async get(id: string): Promise<string | null> {
    try {
      return await readFile(this.file(id), "utf8");
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await unlink(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<{ id: string; value: string }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: { id: string; value: string }[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        out.push({ id: n.slice(0, -5), value: await readFile(join(this.dir, n), "utf8") });
      } catch {
        /* gone since the listing */
      }
    }
    return out;
  }
}

/**
 * The shared database. Each record is one key with an expiry, plus its id in a
 * per-store set, so the store can be listed without scanning the database.
 */
export class KvBackend implements RecordBackend {
  constructor(
    private readonly kv: Kv,
    /** e.g. "checkout": keys are sigpath:<namespace>:<order>. */
    private readonly namespace: string,
    /** The database deletes a record this long after it was written. */
    private readonly ttlSecs: number,
  ) {
    if (!/^[a-z-]+$/.test(namespace)) throw new Error("Invalid store namespace.");
    if (!Number.isInteger(ttlSecs) || ttlSecs <= 0) throw new Error("A database record needs an expiry.");
  }

  private key(id: string): string {
    return `sigpath:${this.namespace}:${id}`;
  }

  private get index(): string {
    return `sigpath:${this.namespace}:index`;
  }

  async putIfAbsent(id: string, value: string): Promise<boolean> {
    // The index entry first: if the write then fails, list() drops the
    // dangling id, whereas a record missing from the index would never be swept.
    await this.kv.command(["SADD", this.index, id]);
    const ok = await this.kv.command<string | null>(["SET", this.key(id), value, "NX", "EX", this.ttlSecs]);
    return ok === "OK";
  }

  async get(id: string): Promise<string | null> {
    return (await this.kv.command<string | null>(["GET", this.key(id)])) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const [deleted] = await this.kv.pipeline([
      ["DEL", this.key(id)],
      ["SREM", this.index, id],
    ]);
    return deleted === 1;
  }

  async list(): Promise<{ id: string; value: string }[]> {
    const ids = (await this.kv.command<string[]>(["SMEMBERS", this.index])) ?? [];
    const out: { id: string; value: string }[] = [];
    const expired: string[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const values = await this.kv.command<(string | null)[]>(["MGET", ...batch.map((id) => this.key(id))]);
      batch.forEach((id, j) => (values[j] === null ? expired.push(id) : out.push({ id, value: values[j]! })));
    }
    // Records the database already expired: forget their ids too.
    if (expired.length) await this.kv.command(["SREM", this.index, ...expired]);
    return out;
  }
}

/**
 * The database when one is configured, else files. An explicit directory
 * setting (e.g. ADDRESS_STORE_DIR) still means files: that is a deliberate choice.
 */
export function backendFromEnv(
  env: Record<string, string | undefined>,
  opts: { explicitDir?: string; defaultDir: string; namespace: string; ttlSecs: number },
): RecordBackend {
  const explicit = opts.explicitDir?.trim();
  if (explicit) return new FileBackend(explicit);
  const kv = UpstashKv.fromEnv(env);
  return kv ? new KvBackend(kv, opts.namespace, opts.ttlSecs) : new FileBackend(opts.defaultDir);
}

export class EncryptedStore<T> {
  protected readonly backend: RecordBackend;

  constructor(
    /** A backend, or a directory for one file per order. */
    backend: RecordBackend | string,
    private readonly key: Buffer,
    /**
     * Mixed into the authenticated data. Empty for the address store, which
     * predates this class and must keep decrypting its existing records;
     * every newer store names itself.
     */
    private readonly purpose: string,
  ) {
    if (key.length !== 32) throw new Error("Store key must be 32 bytes.");
    this.backend = typeof backend === "string" ? new FileBackend(backend) : backend;
  }

  private aad(order: string): Buffer {
    return Buffer.from(this.purpose ? `${this.purpose}:${order}` : order, "utf8");
  }

  /**
   * The ONLY way an order id becomes a file name or a database key. A base58
   * public key cannot contain a path separator, "..", or ":", and re-encoding
   * it through PublicKey rejects anything that merely looks like one.
   */
  protected id(order: string): string {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(order)) throw new Error("Invalid order id.");
    const canonical = new PublicKey(order).toBase58();
    if (canonical !== order) throw new Error("Invalid order id.");
    return canonical;
  }

  /** Write-once: an existing record for this order is never overwritten. */
  async put(order: string, record: T, now = Date.now()): Promise<void> {
    const id = this.id(order);
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
    if (!(await this.backend.putIfAbsent(id, JSON.stringify(file)))) {
      throw new Error("A record already exists for this order.");
    }
  }

  async get(order: string): Promise<{ record: T; createdAt: number } | null> {
    const raw = await this.backend.get(this.id(order));
    if (raw === null) return null;
    let file: StoredFile;
    try {
      file = JSON.parse(raw);
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
    return (await this.backend.get(this.id(order))) !== null;
  }

  /** True if a record existed and is now gone. */
  async delete(order: string): Promise<boolean> {
    return this.backend.delete(this.id(order));
  }

  async list(): Promise<{ order: string; createdAt: number }[]> {
    const out: { order: string; createdAt: number }[] = [];
    for (const { value } of await this.backend.list()) {
      try {
        const f: StoredFile = JSON.parse(value);
        if (f.v === 1 && typeof f.order === "string") out.push({ order: f.order, createdAt: f.createdAt });
      } catch {
        /* a record that is not ours to judge; leave it */
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
