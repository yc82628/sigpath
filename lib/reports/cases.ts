/**
 * lib/reports/cases.ts — the seller's side of each report.
 *
 * One entry per reported order: which seller it concerns, when it was filed,
 * when the seller was notified, and what they said. Deliberately separate from
 * the encrypted pending report, for two reasons:
 *
 *   - it holds NOTHING about the buyer, so it can outlive the report (the
 *     seller's reply stays beside the finding after the buyer's data is gone)
 *   - it changes over time (notified, replied, appealed), and the pending
 *     report is write-once by design
 *
 * The seller's words are the seller's own statement, made to be read beside
 * the finding — so they are shown on the public seller page. The reply form
 * says so before they submit.
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

/** How long a notified seller has to reply before a report can be upheld without them. */
export const REPLY_WINDOW_SECS = 7 * 24 * 3600;
export const RESPONSE_MAX = 1000;

export interface SellerResponse {
  text: string;
  at: number;
}

export interface Case {
  sellerKey: string;
  filedAt: number;
  /** When the operator sent the notice through the marketplace. Starts the reply window. */
  notifiedAt?: number;
  /** Before a decision: the seller's answer to the report. */
  reply?: SellerResponse;
  /** After an upheld decision: the seller contesting it. */
  appeal?: SellerResponse;
}

export class CaseLog {
  constructor(private readonly file: string) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): CaseLog {
    return new CaseLog(env.REPORT_CASES_FILE?.trim() || join(process.cwd(), ".data", "reports", "cases.json"));
  }

  async all(): Promise<Record<string, Case>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  async get(order: string): Promise<Case | null> {
    return (await this.all())[order] ?? null;
  }

  async forSeller(sellerKey: string): Promise<{ order: string; c: Case }[]> {
    return Object.entries(await this.all())
      .filter(([, c]) => c.sellerKey === sellerKey)
      .map(([order, c]) => ({ order, c }));
  }

  private async write(all: Record<string, Case>) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async open(order: string, sellerKey: string, filedAt: number): Promise<void> {
    const all = await this.all();
    if (all[order]) throw new Error("A case for this order already exists.");
    all[order] = { sellerKey, filedAt };
    await this.write(all);
  }

  /** Delete every case about one seller — their replies and appeals are their own words. Returns how many. */
  async removeSeller(sellerKey: string): Promise<number> {
    const all = await this.all();
    const orders = Object.keys(all).filter((o) => all[o].sellerKey === sellerKey);
    for (const o of orders) delete all[o];
    if (orders.length) await this.write(all);
    return orders.length;
  }

  /** Record the notice. Idempotent: the FIRST notice starts the window; re-sending doesn't restart it. */
  async markNotified(order: string, at: number): Promise<Case> {
    const all = await this.all();
    const c = all[order];
    if (!c) throw new Error("No case for that order.");
    c.notifiedAt ??= at;
    await this.write(all);
    return c;
  }

  /** One reply and one appeal per case. Write-once, so a response can't be rewritten after the fact. */
  async respond(order: string, kind: "reply" | "appeal", r: SellerResponse): Promise<Case> {
    const all = await this.all();
    const c = all[order];
    if (!c) throw new Error("No case for that order.");
    if (c[kind]) throw new Error(`The seller has already submitted a ${kind} for this report.`);
    c[kind] = r;
    await this.write(all);
    return c;
  }
}

export function cleanResponse(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  return s.length >= 10 && s.length <= RESPONSE_MAX ? s : null;
}
