/**
 * lib/alerts/watches.ts — price-drop alerts, with no account.
 *
 * WHAT IS STORED, AND FOR HOW LONG
 * Per alert: the search text, new or used, a target price, and the browser's
 * push endpoint — an opaque URL at its vendor's push service that identifies a
 * browser install, not a person. No email, no name, no wallet. Alerts expire
 * after 30 days; the browser that made one can delete it at any time, and an
 * endpoint the push service reports as gone takes its alerts with it. This is
 * opt-in, and the page says exactly this before asking — the rest of search
 * still stores nothing.
 *
 * THE ENDPOINT IS THE KEY
 * Whoever holds the endpoint can list, read and delete that browser's alerts —
 * and only the browser that subscribed holds it. It is never shown on a page
 * and never logged.
 *
 * ONLY CHECKED DEALS FIRE
 * An alert fires when the best SigPath-checked deal for the search drops below
 * the target — never for a flagged or unchecked listing. A price far under the
 * market is exactly the bait a scam uses; an alert that shouted "price drop!"
 * about it would be SigPath doing the scammer's work.
 */

import { join } from "path";
import { randomUUID } from "crypto";
import type { Money } from "../marketplace/types";
import { dataDir } from "../data-dir";
import { asTable, tableFromEnv, type Table } from "../kv/table";

export const WATCH_TTL_SECS = 30 * 24 * 3600;
export const MAX_WATCHES_PER_BROWSER = 10;
export const QUERY_MAX = 120;

export interface PendingAlert {
  title: string;
  body: string;
  url: string;
  at: number;
}

export interface Watch {
  id: string;
  endpoint: string;
  query: string;
  group: "new" | "used";
  target: Money;
  createdAt: number;
  expiresAt: number;
  /** The best checked price last alerted on. A new alert needs a NEW low. */
  lastAlerted?: Money;
  lastCheckedAt?: number;
  /** Waiting for the service worker to collect. */
  pending?: PendingAlert;
}

export class WatchStore {
  private readonly table: Table<Watch>;

  constructor(table: Table<Watch> | string) {
    this.table = asTable(table);
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): WatchStore {
    return new WatchStore(
      tableFromEnv(env, {
        explicitFile: env.ALERTS_FILE,
        defaultFile: join(dataDir(env), "alerts", "watches.json"),
        name: "price-alerts",
      }),
    );
  }

  async all(): Promise<Record<string, Watch>> {
    return this.table.all();
  }

  async forEndpoint(endpoint: string): Promise<Watch[]> {
    return Object.values(await this.table.all()).filter((w) => w.endpoint === endpoint);
  }

  async add(input: Omit<Watch, "id" | "createdAt" | "expiresAt">, nowS: number): Promise<Watch> {
    if ((await this.forEndpoint(input.endpoint)).length >= MAX_WATCHES_PER_BROWSER) throw new WatchLimitError();
    const w: Watch = { ...input, id: randomUUID(), createdAt: nowS, expiresAt: nowS + WATCH_TTL_SECS };
    await this.table.set(w.id, w);
    return w;
  }

  /** Deletes only if `endpoint` owns it — the endpoint is the only credential. */
  async remove(id: string, endpoint: string): Promise<boolean> {
    if ((await this.table.get(id))?.endpoint !== endpoint) return false;
    return (await this.table.delete(id)) > 0;
  }

  async removeEndpoint(endpoint: string): Promise<number> {
    return this.table.delete(...(await this.forEndpoint(endpoint)).map((w) => w.id));
  }

  /** Hand pending alerts to the browser that owns them, and clear them. */
  async collect(endpoint: string): Promise<PendingAlert[]> {
    const out: PendingAlert[] = [];
    const cleared: Record<string, Watch> = {};
    for (const w of await this.forEndpoint(endpoint)) {
      if (!w.pending) continue;
      out.push(w.pending);
      const { pending: _, ...rest } = w;
      cleared[w.id] = rest;
    }
    await this.table.setMany(cleared);
    return out;
  }

  async update(id: string, patch: Partial<Watch>): Promise<void> {
    const w = await this.table.get(id);
    if (!w) return;
    await this.table.set(id, { ...w, ...patch });
  }

  async sweep(nowS: number): Promise<number> {
    const all = await this.table.all();
    return this.table.delete(...Object.keys(all).filter((id) => nowS >= all[id].expiresAt));
  }
}

export class WatchLimitError extends Error {
  constructor() {
    super(`A browser can keep up to ${MAX_WATCHES_PER_BROWSER} alerts. Delete one to add another.`);
  }
}

/** Search text, normalised so "ThinkPad  X1" and "thinkpad x1" are one search, run once. */
export function normaliseQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase().slice(0, QUERY_MAX);
}
