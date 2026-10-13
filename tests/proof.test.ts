import { test } from "node:test";
import assert from "node:assert";
import { linkFindings, summariseOrders, ISSUER, type RawReport, type RawReversal } from "../lib/proof/ledger";
import { reportNonce } from "../lib/chains/solana/sas-reports";
import { OPERATOR } from "../lib/chains/solana/orders";

/**
 * /proof reads SigPath's record from Solana. These pin the parts that turn raw
 * accounts into what the page says: the escrow's totals, and which finding a
 * reversal belongs to.
 */

const subject = (n: number) => Buffer.alloc(32, n).toString("hex");
const report = (s: number, index: number, upheldAt: number, category = 1): RawReport => ({
  address: `report-${s}-${index}`,
  nonce: reportNonce(Buffer.from(subject(s), "hex"), index),
  subject: subject(s),
  category,
  upheldAt,
});

test("the escrow's totals: counts per status, and the USDC each status holds", () => {
  const s = summariseOrders([
    { status: "funded", amount: 2_500_000n },
    { status: "fulfilled", amount: 1_000_000n },
    { status: "fulfilled", amount: 500_000n },
    { status: "refunded", amount: 750_000n },
  ]);
  assert.deepStrictEqual(s, { total: 4, funded: 1, fulfilled: 2, refunded: 1, heldNow: 2_500_000, paidOut: 1_500_000, returned: 750_000 });
  assert.deepStrictEqual(summariseOrders([]), { total: 0, funded: 0, fulfilled: 0, refunded: 0, heldNow: 0, paidOut: 0, returned: 0 });
});

test("a finding's number comes back from its nonce, and its reversal is paired by seller and number", () => {
  const reports = [report(1, 0, 100), report(1, 1, 200, 2), report(2, 0, 150)];
  const reversals: RawReversal[] = [{ address: "rev-1-1", subject: subject(1), reportIndex: 1, reversedAt: 300 }];
  const out = linkFindings(reports, reversals);

  assert.deepStrictEqual(
    out.map((f) => [f.address, f.index, f.category, f.reversal?.address ?? null]),
    [
      ["report-1-1", 1, "not_as_described", "rev-1-1"],
      ["report-2-0", 0, "counterfeit", null],
      ["report-1-0", 0, "counterfeit", null],
    ],
    "newest first; only seller 1's second finding is reversed",
  );
});

test("a reversal for the same number but another seller doesn't reverse anything", () => {
  const out = linkFindings([report(1, 0, 100)], [{ address: "rev", subject: subject(9), reportIndex: 0, reversedAt: 200 }]);
  assert.strictEqual(out[0].reversal, null);
});

test("a nonce that matches no number is shown without one, and an unknown category as none", () => {
  const odd: RawReport = { ...report(3, 0, 100, 7), nonce: reportNonce(Buffer.from(subject(3), "hex"), 5) };
  const [f] = linkFindings([odd], [{ address: "rev", subject: subject(3), reportIndex: 0, reversedAt: 1 }]);
  assert.strictEqual(f.index, null);
  assert.strictEqual(f.category, null);
  assert.strictEqual(f.reversal, null, "no number, so no reversal can be paired with it");
});

test("the issuer is the escrow's operator: one key names everything SigPath signs", () => {
  assert.strictEqual(ISSUER, OPERATOR.toBase58());
});
