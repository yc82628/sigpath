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

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { dirname, join } from "path";
import { randomBytes, randomUUID } from "crypto";
import type { Money } from "../marketplace/types";
import { dataDir } from "../data-dir";

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
  constructor(private readonly file: string) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): WatchStore {
    return new WatchStore(env.ALERTS_FILE?.trim() || join(dataDir(env), "alerts", "watches.json"));
  }

  async all(): Promise<Record<string, Watch>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private async write(all: Record<string, Watch>) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async forEndpoint(endpoint: string): Promise<Watch[]> {
    return Object.values(await this.all()).filter((w) => w.endpoint === endpoint);
  }

  async add(input: Omit<Watch, "id" | "createdAt" | "expiresAt">, nowS: number): Promise<Watch> {
    const all = await this.all();
    const mine = Object.values(all).filter((w) => w.endpoint === input.endpoint);
    if (mine.length >= MAX_WATCHES_PER_BROWSER) throw new WatchLimitError();
    const w: Watch = { ...input, id: randomUUID(), createdAt: nowS, expiresAt: nowS + WATCH_TTL_SECS };
    all[w.id] = w;
    await this.write(all);
    return w;
  }

  /** Deletes only if `endpoint` owns it — the endpoint is the only credential. */
  async remove(id: string, endpoint: string): Promise<boolean> {
    const all = await this.all();
    if (all[id]?.endpoint !== endpoint) return false;
    delete all[id];
    await this.write(all);
    return true;
  }

  async removeEndpoint(endpoint: string): Promise<number> {
    const all = await this.all();
    const ids = Object.keys(all).filter((id) => all[id].endpoint === endpoint);
    for (const id of ids) delete all[id];
    if (ids.length) await this.write(all);
    return ids.length;
  }

  /** Hand pending alerts to the browser that owns them, and clear them. */
  async collect(endpoint: string): Promise<PendingAlert[]> {
    const all = await this.all();
    const out: PendingAlert[] = [];
    for (const w of Object.values(all)) {
      if (w.endpoint === endpoint && w.pending) {
        out.push(w.pending);
        delete w.pending;
      }
    }
    if (out.length) await this.write(all);
    return out;
  }

  async update(id: string, patch: Partial<Watch>): Promise<void> {
    const all = await this.all();
    if (!all[id]) return;
    all[id] = { ...all[id], ...patch };
    await this.write(all);
  }

  async sweep(nowS: number): Promise<number> {
    const all = await this.all();
    const ids = Object.keys(all).filter((id) => nowS >= all[id].expiresAt);
    for (const id of ids) delete all[id];
    if (ids.length) await this.write(all);
    return ids.length;
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
