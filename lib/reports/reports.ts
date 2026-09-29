/**
 * lib/reports/reports.ts — fake-product reports from verified buyers.
 *
 * THE PROBLEM
 * Fake products get listed, sold, and the seller faces nothing: the listing
 * comes down at worst, and the same seller lists again. SigPath cannot ban
 * anyone from eBay. What it can do is make the consequence follow the seller —
 * across every SigPath search, out of SigPath's checkout, and onto a public
 * on-chain record any other app can read.
 *
 * THE DANGER THAT SHAPES EVERYTHING HERE
 * A false report is as harmful as a fake product. A competitor filing reports
 * against a rival, or a buyer inventing one, damages an honest seller — and in
 * Germany, publicly calling someone a counterfeiter without solid grounds is a
 * legal problem, not just an unfair one. So a report has to clear three bars
 * before it can affect anyone, and nothing is public until a person decides:
 *
 *   1. PROOF OF PURCHASE — only for a SigPath order that was paid and
 *      fulfilled on chain, within REPORT_WINDOW_SECS of fulfilment, one report
 *      per order.
 *   2. PROOF IT IS THE BUYER — a signature from the wallet that paid, over a
 *      message naming the order. Anyone can read who paid; only the payer can
 *      sign as them.
 *   3. PROOF OF POSSESSION — a live photo of the item beside a handwritten
 *      code issued moments earlier, so the evidence is theirs and current, not
 *      a picture lifted from the listing or from someone else's complaint.
 *
 * Then a reviewer upholds or dismisses it. The vision check cannot tell a fake
 * from a genuine article — that judgement is human, and it is the only thing
 * that publishes anything.
 *
 * PERSONAL DATA
 * A pending report holds the buyer's words, photo and wallet, encrypted. The
 * moment it is decided, all of that is DELETED; what remains is a decision
 * record with nothing personal in it — seller, category, date, and hashes that
 * tie the decision to the evidence it was made on.
 */

import nacl from "tweetnacl";
import { createHash, randomBytes, randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { EncryptedStore, keyFromEnv } from "../checkout/encrypted-store";
import { readOrder } from "../checkout/checkout";
import { OrderMetaStore, REPORT_WINDOW_SECS, type OrderMeta } from "./order-meta";
import type { ChallengeVerification } from "../challenge/verify";
import { listingHash } from "../chains/solana/orders";
import type { ReportCategory } from "../chains/solana/sas-reports";

export const REPORT_CATEGORIES: readonly ReportCategory[] = ["counterfeit", "not_as_described"];
export const DESCRIPTION_MAX = 500;
/** A signed intent must be used within this long. */
export const INTENT_TTL_MS = 15 * 60 * 1000;
/** A report nobody has reviewed is not kept forever. */
export const PENDING_REPORT_MAX_SECS = 90 * 24 * 3600;

// One definition of seller identity, shared with search — see marketplace/types.
import { sellerKey } from "../marketplace/types";
export { sellerKey };

// ---------------------------------------------------------------------------
// Pending reports — encrypted, personal
// ---------------------------------------------------------------------------

export interface ReportRecord {
  order: string;
  buyer: string;
  seller: OrderMeta["seller"];
  listing: OrderMeta["listing"];
  category: ReportCategory;
  description: string;
  evidence: {
    imageBase64: string;
    mediaType: string;
    /** Published on upheld, so the decision can later be tied to this evidence. */
    sha256: string;
    /** What the vision check saw — context for the reviewer, not a verdict. */
    observed: string;
    confidence: number;
  };
}

export class ReportStore extends EncryptedStore<ReportRecord> {
  static fromEnv(env: Record<string, string | undefined> = process.env): ReportStore | null {
    const key = keyFromEnv(env);
    if (!key) return null;
    return new ReportStore(env.REPORT_STORE_DIR?.trim() || join(process.cwd(), ".data", "reports", "pending"), key, "report");
  }

  static withKey(dir: string, key: Buffer): ReportStore {
    return new ReportStore(dir, key, "report");
  }
}

// ---------------------------------------------------------------------------
// Decisions — public-safe, nothing personal
// ---------------------------------------------------------------------------

export interface Decision {
  status: "upheld" | "dismissed" | "expired";
  sellerKey: string;
  category: ReportCategory;
  decidedAt: number;
  evidenceSha256: string;
  listingHash: string;
  /** Upheld only: the seller's report index and its on-chain attestation. */
  index?: number;
  attestation?: string;
}

/**
 * The decision log. A plain JSON file, written atomically, never edited in
 * place: a decision once recorded is not overwritten. It holds no personal
 * data, which is what lets it outlive the pending report.
 */
export class DecisionLog {
  constructor(private readonly file: string) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): DecisionLog {
    return new DecisionLog(env.REPORT_DECISIONS_FILE?.trim() || join(process.cwd(), ".data", "reports", "decisions.json"));
  }

  async all(): Promise<Record<string, Decision>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  async get(order: string): Promise<Decision | null> {
    return (await this.all())[order] ?? null;
  }

  async record(order: string, d: Decision): Promise<void> {
    const all = await this.all();
    if (all[order]) throw new Error("A decision for this order already exists.");
    all[order] = d;
    await mkdir(dirname(this.file), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the old log intact rather
    // than a truncated one that parses as "no decisions".
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Upheld reports per seller — what search flags and the checkout gate read. */
  async upheldCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const d of Object.values(await this.all())) {
      if (d.status === "upheld") counts.set(d.sellerKey, (counts.get(d.sellerKey) ?? 0) + 1);
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface ReportDeps {
  conn: Connection;
  metaStore: OrderMetaStore;
  reportStore: ReportStore;
  decisions: DecisionLog;
  now?: number;
}

type Refusal = { ok: false; status: number; error: string };

/** Can this order be reported, and — when `wallet` is given — by this wallet? */
export async function checkReportable(
  orderStr: string,
  wallet: string | null,
  deps: ReportDeps,
): Promise<{ ok: true; meta: OrderMeta; buyer: string } | Refusal> {
  let order: PublicKey;
  try {
    order = new PublicKey(orderStr);
  } catch {
    return { ok: false, status: 400, error: "Invalid order address." };
  }

  let state;
  try {
    state = await readOrder(deps.conn, order);
  } catch {
    return { ok: false, status: 404, error: "That isn't a SigPath order." };
  }
  if (!state.found) return { ok: false, status: 404, error: "No such order." };
  if (state.status !== "fulfilled") {
    return {
      ok: false,
      status: 409,
      error:
        state.status === "funded"
          ? "This order hasn't been fulfilled yet — if it never arrives, the escrow refunds you."
          : "This order was refunded, so there is nothing to report.",
    };
  }
  if (wallet !== null && wallet !== state.buyer.toBase58()) {
    return { ok: false, status: 403, error: "Only the wallet that paid for this order can report it." };
  }

  const nowS = Math.floor((deps.now ?? Date.now()) / 1000);
  if (nowS > state.settledAt + REPORT_WINDOW_SECS) {
    return { ok: false, status: 409, error: "The 30-day window for reporting this order has closed." };
  }
  if ((await deps.decisions.get(orderStr)) || (await deps.reportStore.has(orderStr))) {
    return { ok: false, status: 409, error: "This order has already been reported." };
  }

  const meta = await deps.metaStore.get(orderStr).catch(() => null);
  if (!meta) {
    return { ok: false, status: 409, error: "SigPath has no record of who sold this order, so it can't be reported." };
  }
  return { ok: true, meta: meta.record, buyer: state.buyer.toBase58() };
}

// ---------------------------------------------------------------------------
// Intents: the buyer proves who they are before any capture starts
// ---------------------------------------------------------------------------

interface Intent {
  id: string;
  order: string;
  wallet: string;
  message: string;
  createdAt: number;
  verified: boolean;
  sessionId?: string;
}

/**
 * In memory, like the capture challenges: a signed intent lives fifteen
 * minutes and one process. Fine for a single instance; move to shared storage
 * before running more than one.
 */
const INTENTS = new Map<string, Intent>();

/**
 * The exact text the wallet signs. It names the purpose, the order and the
 * wallet, and carries a fresh nonce — so a signature cannot be replayed onto a
 * different order, or lifted from some other site's "sign to log in" prompt.
 */
export function reportMessage(order: string, wallet: string, nonce: string, issuedAt: string): string {
  return [
    "SigPath fake-product report",
    `I am the buyer of order ${order} and I am reporting the item I received.`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
  ].join("\n");
}

function liveIntent(id: string, now: number): Intent | null {
  const it = INTENTS.get(id);
  if (!it) return null;
  if (now - it.createdAt > INTENT_TTL_MS) {
    INTENTS.delete(id);
    return null;
  }
  return it;
}

export async function createReportIntent(
  input: { order: unknown; wallet: unknown },
  deps: ReportDeps,
): Promise<{ ok: true; intentId: string; message: string } | Refusal> {
  const order = String(input.order ?? "");
  let wallet: string;
  try {
    wallet = new PublicKey(String(input.wallet)).toBase58();
  } catch {
    return { ok: false, status: 400, error: "Invalid wallet address." };
  }
  const check = await checkReportable(order, wallet, deps);
  if (!check.ok) return check;

  const now = deps.now ?? Date.now();
  const intent: Intent = {
    id: randomUUID(),
    order,
    wallet,
    message: reportMessage(order, wallet, randomBytes(16).toString("hex"), new Date(now).toISOString()),
    createdAt: now,
    verified: false,
  };
  INTENTS.set(intent.id, intent);
  return { ok: true, intentId: intent.id, message: intent.message };
}

/** Check the wallet's signature over the intent message. ed25519, as every Solana wallet signs. */
export function verifyIntentSignature(
  intentId: string,
  signatureBase64: unknown,
  now = Date.now(),
): { ok: true } | Refusal {
  const it = liveIntent(intentId, now);
  if (!it) return { ok: false, status: 404, error: "This report session has expired. Start again." };
  if (typeof signatureBase64 !== "string") return { ok: false, status: 400, error: "Missing signature." };

  const sig = Buffer.from(signatureBase64, "base64");
  if (sig.length !== 64) return { ok: false, status: 400, error: "Malformed signature." };
  const valid = nacl.sign.detached.verify(
    new TextEncoder().encode(it.message),
    new Uint8Array(sig),
    new PublicKey(it.wallet).toBytes(),
  );
  if (!valid) return { ok: false, status: 403, error: "The signature doesn't match the wallet that paid for this order." };
  it.verified = true;
  return { ok: true };
}

/** Tie the evidence capture to this intent, so no other capture can be substituted. */
export function bindEvidenceSession(intentId: string, sessionId: string, now = Date.now()): { ok: true } | Refusal {
  const it = liveIntent(intentId, now);
  if (!it || !it.verified) return { ok: false, status: 403, error: "Sign with your wallet before starting the camera." };
  it.sessionId = sessionId;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

function cleanDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  return s.length >= 10 && s.length <= DESCRIPTION_MAX ? s : null;
}

export async function submitReport(
  input: {
    intentId: unknown;
    sessionId: unknown;
    imageBase64: unknown;
    mediaType: unknown;
    category: unknown;
    description: unknown;
  },
  deps: ReportDeps & {
    /** The vision check for the evidence session. Injected so tests can stub it. */
    verify: (sessionId: string, payload: { imageBase64: string; mediaType: string }) => Promise<ChallengeVerification>;
  },
): Promise<{ ok: true; passed: true } | { ok: true; passed: false; reason: string } | Refusal> {
  const now = deps.now ?? Date.now();
  const it = liveIntent(String(input.intentId ?? ""), now);
  if (!it || !it.verified) return { ok: false, status: 403, error: "This report session has expired or was never signed." };
  if (!it.sessionId || input.sessionId !== it.sessionId) {
    return { ok: false, status: 403, error: "That capture doesn't belong to this report." };
  }
  const category = REPORT_CATEGORIES.find((c) => c === input.category);
  if (!category) return { ok: false, status: 400, error: "Choose what was wrong with the item." };
  const description = cleanDescription(input.description);
  if (!description) {
    return { ok: false, status: 400, error: `Describe the problem in 10 to ${DESCRIPTION_MAX} characters.` };
  }
  if (typeof input.imageBase64 !== "string" || typeof input.mediaType !== "string") {
    return { ok: false, status: 400, error: "No photo was captured." };
  }

  // Re-check: the order could have been reported from another tab since.
  const check = await checkReportable(it.order, it.wallet, deps);
  if (!check.ok) return check;

  const v = await deps.verify(it.sessionId, { imageBase64: input.imageBase64, mediaType: input.mediaType });
  if (v.unavailable) return { ok: false, status: 503, error: `The photo check couldn't run: ${v.unavailable}` };
  if (!v.passed) return { ok: true, passed: false, reason: v.failureReason || "The photo didn't pass the check." };

  const record: ReportRecord = {
    order: it.order,
    buyer: it.wallet,
    seller: check.meta.seller,
    listing: check.meta.listing,
    category,
    description,
    evidence: {
      imageBase64: input.imageBase64,
      mediaType: input.mediaType,
      sha256: createHash("sha256").update(Buffer.from(input.imageBase64, "base64")).digest("hex"),
      observed: v.observed,
      confidence: v.confidence,
    },
  };
  try {
    await deps.reportStore.put(it.order, record, now);
  } catch {
    return { ok: false, status: 409, error: "This order has already been reported." };
  }
  INTENTS.delete(it.id);
  return { ok: true, passed: true };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export function listingHashHex(listing: OrderMeta["listing"]): string {
  // THE SAME commitment the escrow stored on chain when the order was created —
  // reused, not re-derived, so the two can never disagree about which listing
  // a report is for.
  return listingHash(listing).toString("hex");
}

/**
 * Uphold or dismiss a pending report.
 *
 * On uphold, `publish` writes the on-chain attestation FIRST; the decision is
 * recorded only if that succeeded, so the local count and the chain cannot
 * disagree about which index was used. Either way, once the decision is
 * recorded the pending report — the buyer's photo, words and wallet — is
 * deleted.
 */
export async function decideReport(
  order: string,
  status: "upheld" | "dismissed",
  deps: {
    reportStore: ReportStore;
    decisions: DecisionLog;
    /**
     * Writes the on-chain record. Gets the local count as a hint and returns
     * the index it ACTUALLY used — the chain's count is authoritative, since
     * public enumeration walks the chain's indices and a gap or a reuse there
     * would silently undercount a seller's record.
     */
    publish?: (
      r: ReportRecord,
      localIndex: number,
      upheldAt: number,
    ) => Promise<{ attestation: string; index: number } | { error: string }>;
    now?: number;
  },
): Promise<{ ok: true; decision: Decision } | { ok: false; error: string }> {
  const pending = await deps.reportStore.get(order);
  if (!pending) return { ok: false, error: "No pending report for that order." };
  if (await deps.decisions.get(order)) return { ok: false, error: "That report has already been decided." };

  const r = pending.record;
  const key = sellerKey(r.seller.source, r.seller.handle);
  const decidedAt = Math.floor((deps.now ?? Date.now()) / 1000);
  const decision: Decision = {
    status,
    sellerKey: key,
    category: r.category,
    decidedAt,
    evidenceSha256: r.evidence.sha256,
    listingHash: listingHashHex(r.listing),
  };

  if (status === "upheld") {
    const index = (await deps.decisions.upheldCounts()).get(key) ?? 0;
    decision.index = index;
    if (deps.publish) {
      const pub = await deps.publish(r, index, decidedAt);
      if ("error" in pub) return { ok: false, error: `Not published, so not recorded: ${pub.error}` };
      decision.attestation = pub.attestation;
      decision.index = pub.index;
    }
  }

  await deps.decisions.record(order, decision);
  await deps.reportStore.delete(order);
  return { ok: true, decision };
}

/** Reports nobody reviewed in time are closed, not kept: recorded as expired, evidence deleted. */
export async function expireStaleReports(
  deps: { reportStore: ReportStore; decisions: DecisionLog; now?: number },
): Promise<string[]> {
  const nowS = Math.floor((deps.now ?? Date.now()) / 1000);
  const expired: string[] = [];
  for (const { order, createdAt } of await deps.reportStore.list()) {
    if (nowS - createdAt <= PENDING_REPORT_MAX_SECS) continue;
    const pending = await deps.reportStore.get(order).catch(() => null);
    if (pending && !(await deps.decisions.get(order))) {
      const r = pending.record;
      await deps.decisions.record(order, {
        status: "expired",
        sellerKey: sellerKey(r.seller.source, r.seller.handle),
        category: r.category,
        decidedAt: nowS,
        evidenceSha256: r.evidence.sha256,
        listingHash: listingHashHex(r.listing),
      });
    }
    if (await deps.reportStore.delete(order)) expired.push(order);
  }
  return expired;
}

/** Test hook. */
export function _clearIntents() {
  INTENTS.clear();
}
