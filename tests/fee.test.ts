import { test } from "node:test";
import assert from "node:assert";
import { DEFAULT_FEE_BPS, formatFeeRate, serviceFeeBps, withServiceFee } from "../lib/checkout/fee";
import { signQuote, verifyQuote } from "../lib/checkout/quote";

const SECRET = { QUOTE_SECRET: "q".repeat(40) };
const LISTING = { source: "ebay", id: "1", url: "https://www.ebay.de/itm/1", title: "t", seller: "s", amount: 24900, currency: "EUR" };

test("the default service fee is 2%, and the setting can change it within reason", () => {
  assert.equal(DEFAULT_FEE_BPS, 200);
  assert.equal(serviceFeeBps({}), 200);
  assert.equal(serviceFeeBps({ SIGPATH_FEE_BPS: "150" }), 150);
  assert.equal(serviceFeeBps({ SIGPATH_FEE_BPS: "0" }), 0, "a free checkout is a valid choice");
  // A typo never becomes a price.
  for (const bad of ["2", "1.5", "-100", "5000", "abc"]) {
    assert.equal(serviceFeeBps({ SIGPATH_FEE_BPS: bad }), bad === "2" ? 2 : 200, bad);
  }
});

test("the fee rounds UP to the smallest USDC unit, and the total is price + fee", () => {
  assert.deepEqual(withServiceFee(100_000_000n, 200), { price: 100_000_000n, fee: 2_000_000n, total: 102_000_000n });
  // 2% of 0.000049 USDC is 0.00000098: never rounded down to nothing.
  assert.equal(withServiceFee(49n, 200).fee, 1n);
  assert.equal(withServiceFee(283_038_300n, 200).fee, 5_660_766n);
  assert.equal(withServiceFee(283_038_300n, 0).total, 283_038_300n);
  assert.throws(() => withServiceFee(1n, 1001));
  assert.throws(() => withServiceFee(1n, 1.5));
});

test("the rate is signed into the quote, and a tampered rate fails the signature", () => {
  const token = signQuote(LISTING, { ...SECRET, SIGPATH_FEE_BPS: "200" })!;
  const v = verifyQuote(token, SECRET);
  assert.ok(v.ok && v.listing.feeBps === 200);

  // Rewrite the fee to 0% in the payload: the signature no longer matches.
  const [payload, sig] = token.split(".");
  const body = JSON.parse(Buffer.from(payload, "base64url").toString());
  const forged = `${Buffer.from(JSON.stringify({ ...body, feeBps: 0 })).toString("base64url")}.${sig}`;
  assert.deepEqual(verifyQuote(forged, SECRET), { ok: false, reason: "bad_signature" });
});

test("the rate is shown as a plain percentage", () => {
  assert.equal(formatFeeRate(200), "2%");
  assert.equal(formatFeeRate(150), "1.5%");
});
