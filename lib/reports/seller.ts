/**
 * lib/reports/seller.ts — what a seller can see, say, and contest.
 *
 * TWO AUDIENCES, TWO VIEWS
 *
 *   The seller, holding a link from the notice, sees every report about them —
 *   including PENDING ones, because a right of reply is meaningless for a report
 *   you cannot read. For a pending report they see the category, the listing
 *   and the buyer's own description of the problem: what they need to answer
 *   it. Never the buyer's photo (it can show a home, a label, a face) and never
 *   the buyer's wallet.
 *
 *   The public sees only UPHELD findings — reversed ones included, marked as
 *   such — each with the seller's reply and appeal beside it. Pending reports
 *   are never public; that rule predates this file and this file keeps it.
 *
 * WHAT A SELLER CAN SUBMIT
 *   before a decision   one REPLY, which the reviewer reads before deciding;
 *                       it also ends the waiting period early
 *   after an upheld one one APPEAL, which asks the reviewer to reverse it
 * Both are write-once, so a statement can't be rewritten after it has been
 * seen, and both are published with the finding — the form says so first.
 */

import { cleanResponse, CaseLog, REPLY_WINDOW_SECS, RESPONSE_MAX, type SellerResponse } from "./cases";
import { DecisionLog, ReportStore, type Decision } from "./reports";
import { verifySellerToken } from "./seller-access";
import type { ReportCategory } from "../chains/solana/sas-reports";

export type FindingStatus = "pending" | "upheld" | "reversed" | "dismissed" | "expired";

export interface SellerFinding {
  order: string;
  status: FindingStatus;
  category?: ReportCategory;
  filedAt: number;
  decidedAt?: number;
  reversedAt?: number;
  /** Pending only, and only in the seller's own view. */
  listing?: { title: string; url: string };
  buyerDescription?: string;
  /** Until when the seller can reply before the report may be upheld without them. */
  replyBy?: number;
  reply?: SellerResponse;
  appeal?: SellerResponse;
  canReply: boolean;
  canAppeal: boolean;
}

function statusOf(d: Decision | null): FindingStatus {
  if (!d) return "pending";
  if (d.status === "upheld") return d.reversal ? "reversed" : "upheld";
  return d.status;
}

/** The seller's own view. Call only after verifying their link. */
export async function sellerFindings(
  sellerKey: string,
  deps: { reportStore: ReportStore; decisions: DecisionLog; cases: CaseLog },
): Promise<SellerFinding[]> {
  const out: SellerFinding[] = [];
  const decisions = await deps.decisions.all();

  for (const { order, c } of await deps.cases.forSeller(sellerKey)) {
    const d = decisions[order] ?? null;
    const status = statusOf(d);
    const f: SellerFinding = {
      order,
      status,
      category: d?.category,
      filedAt: c.filedAt,
      decidedAt: d?.decidedAt,
      reversedAt: d?.reversal?.at,
      reply: c.reply,
      appeal: c.appeal,
      replyBy: c.notifiedAt ? c.notifiedAt + REPLY_WINDOW_SECS : undefined,
      canReply: status === "pending" && !c.reply,
      canAppeal: status === "upheld" && !c.appeal,
    };
    if (status === "pending") {
      const pending = await deps.reportStore.get(order).catch(() => null);
      if (pending) {
        f.category = pending.record.category;
        f.listing = { title: pending.record.listing.title, url: pending.record.listing.url };
        f.buyerDescription = pending.record.description;
      }
    }
    out.push(f);
  }
  return out.sort((a, b) => b.filedAt - a.filedAt);
}

export interface PublicFinding {
  status: "upheld" | "reversed";
  category: ReportCategory;
  decidedAt: number;
  reversedAt?: number;
  attestation?: string;
  reply?: SellerResponse;
  appeal?: SellerResponse;
}

/** What anyone may see about a seller: upheld findings only, each with the seller's own words. */
export async function publicFindings(
  sellerKey: string,
  deps: { decisions: DecisionLog; cases: CaseLog },
): Promise<PublicFinding[]> {
  const cases = await deps.cases.all();
  return Object.entries(await deps.decisions.all())
    .filter(([, d]) => d.sellerKey === sellerKey && d.status === "upheld")
    .map(([order, d]) => ({
      status: d.reversal ? ("reversed" as const) : ("upheld" as const),
      category: d.category,
      decidedAt: d.decidedAt,
      reversedAt: d.reversal?.at,
      attestation: d.attestation,
      reply: cases[order]?.reply,
      appeal: cases[order]?.appeal,
    }))
    .sort((a, b) => b.decidedAt - a.decidedAt);
}

export async function respondAsSeller(
  input: { token: unknown; order: unknown; text: unknown },
  deps: { decisions: DecisionLog; cases: CaseLog; env?: Record<string, string | undefined>; now?: number },
): Promise<{ ok: true; kind: "reply" | "appeal" } | { ok: false; status: number; error: string }> {
  const auth = verifySellerToken(input.token, deps.env, deps.now);
  if (!auth.ok) return { ok: false, status: 401, error: auth.error };

  const order = String(input.order ?? "");
  const c = await deps.cases.get(order);
  // A link is scoped to one seller: it answers reports about that seller only.
  if (!c || c.sellerKey !== auth.sellerKey) return { ok: false, status: 404, error: "No report about you with that id." };

  const text = cleanResponse(input.text);
  if (!text) return { ok: false, status: 400, error: `Write between 10 and ${RESPONSE_MAX} characters.` };

  const status = statusOf(await deps.decisions.get(order));
  const kind = status === "pending" ? "reply" : status === "upheld" ? "appeal" : null;
  if (!kind) return { ok: false, status: 409, error: `This report was ${status}; there is nothing to respond to.` };
  if (c[kind]) return { ok: false, status: 409, error: `You have already submitted a ${kind} for this report.` };

  await deps.cases.respond(order, kind, { text, at: Math.floor((deps.now ?? Date.now()) / 1000) });
  return { ok: true, kind };
}
