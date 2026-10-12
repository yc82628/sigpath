/**
 * lib/kv/table.ts — a keyed set of JSON records: the shared database when one
 * is configured, else one JSON file.
 *
 * WHY
 * Badges, businesses, report decisions and cases, and price alerts each lived
 * in one JSON file under the data directory. On Vercel that directory is the
 * instance's temp disk: per instance, and gone on the next deploy. A badge
 * issued on one instance was missing on the next request served by another,
 * and every deploy wiped them all. Upstash (lib/kv/upstash.ts) is shared by
 * every instance and survives deploys.
 *
 * ONE HASH PER TABLE, ONE FIELD PER RECORD
 * In the database a table is one Redis hash (`sigpath:table:<name>`), each
 * record a field holding its JSON. A write touches only its own record, so two
 * instances writing different records can't overwrite each other, which a
 * read-the-whole-file, write-the-whole-file update would. `setIfAbsent` is
 * HSETNX: "a decision for this order already exists" holds even when two
 * requests race. Records here don't expire: these are logs (a reversed finding
 * stays on the record); stores with an expiry sweep their own.
 *
 * THE FILE
 * Without a database, or with an explicit file setting (REPORT_DECISIONS_FILE
 * and the like: a deliberate choice), it's the same JSON file as before, in
 * the same format, written atomically (write, then rename). Tests and the
 * devnet scripts use files.
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import { randomBytes } from "crypto";
import { UpstashKv, type Kv } from "./upstash";

export interface Table<T> {
  all(): Promise<Record<string, T>>;
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  /** False, and nothing written, if a record already exists for this id. */
  setIfAbsent(id: string, value: T): Promise<boolean>;
  /** Several records in one write. */
  setMany(records: Record<string, T>): Promise<void>;
  /** How many of these ids existed and are now gone. */
  delete(...ids: string[]): Promise<number>;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The whole table in one JSON file, as the logs always were. */
export class FileTable<T> implements Table<T> {
  constructor(readonly file: string) {}

  async all(): Promise<Record<string, T>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private async write(all: Record<string, T>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the old file intact rather
    // than a truncated one that parses as "no records".
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async get(id: string): Promise<T | null> {
    const all = await this.all();
    return has(all, id) ? all[id] : null;
  }

  async set(id: string, value: T): Promise<void> {
    const all = await this.all();
    all[id] = value;
    await this.write(all);
  }

  async setIfAbsent(id: string, value: T): Promise<boolean> {
    const all = await this.all();
    if (has(all, id)) return false;
    all[id] = value;
    await this.write(all);
    return true;
  }

  async setMany(records: Record<string, T>): Promise<void> {
    if (!Object.keys(records).length) return;
    const all = await this.all();
    for (const [id, v] of Object.entries(records)) all[id] = v;
    await this.write(all);
  }

  async delete(...ids: string[]): Promise<number> {
    const all = await this.all();
    let n = 0;
    for (const id of ids) {
      if (has(all, id)) {
        delete all[id];
        n++;
      }
    }
    if (n) await this.write(all);
    return n;
  }
}

/** The table as one hash in the shared database. */
export class KvTable<T> implements Table<T> {
  private readonly key: string;

  constructor(
    private readonly kv: Kv,
    /** e.g. "verified-sellers": the hash is sigpath:table:<name>. */
    name: string,
  ) {
    if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid table name.");
    this.key = `sigpath:table:${name}`;
  }

  /** A field that isn't valid JSON is skipped, not guessed at. */
  private parse(raw: string | null | undefined): T | null {
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async all(): Promise<Record<string, T>> {
    // HGETALL over REST: [field, value, field, value, ...]
    const flat = (await this.kv.command<string[] | null>(["HGETALL", this.key])) ?? [];
    const out: Record<string, T> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const v = this.parse(flat[i + 1]);
      if (v !== null) out[flat[i]] = v;
    }
    return out;
  }

  async get(id: string): Promise<T | null> {
    return this.parse(await this.kv.command<string | null>(["HGET", this.key, id]));
  }

  async set(id: string, value: T): Promise<void> {
    await this.kv.command(["HSET", this.key, id, JSON.stringify(value)]);
  }

  async setIfAbsent(id: string, value: T): Promise<boolean> {
    return (await this.kv.command<number>(["HSETNX", this.key, id, JSON.stringify(value)])) === 1;
  }

  async setMany(records: Record<string, T>): Promise<void> {
    const pairs = Object.entries(records).flatMap(([id, v]) => [id, JSON.stringify(v)]);
    if (pairs.length) await this.kv.command(["HSET", this.key, ...pairs]);
  }

  async delete(...ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    return (await this.kv.command<number>(["HDEL", this.key, ...ids])) ?? 0;
  }
}

/**
 * The database when one is configured, else the file. An explicit file
 * setting still means the file: that is a deliberate choice.
 */
export function tableFromEnv<T>(
  env: Record<string, string | undefined>,
  opts: { explicitFile?: string; defaultFile: string; name: string },
): Table<T> {
  const explicit = opts.explicitFile?.trim();
  if (explicit) return new FileTable<T>(explicit);
  const kv = UpstashKv.fromEnv(env);
  return kv ? new KvTable<T>(kv, opts.name) : new FileTable<T>(opts.defaultFile);
}

/** A path means that file; anything else is a table already chosen. */
export function asTable<T>(t: Table<T> | string): Table<T> {
  return typeof t === "string" ? new FileTable<T>(t) : t;
}
