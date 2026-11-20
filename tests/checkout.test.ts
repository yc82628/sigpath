import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readdirSync, renameSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, createHmac } from "crypto";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { signQuote, verifyQuote, QUOTE_TTL_SECONDS } from "../lib/checkout/quote";
import { eurUsdRate, rateToMicro, toTokenBaseUnits, toUsdcBaseUnits, _resetFxCache } from "../lib/checkout/fx";
import {
  AddressStore,
  validateAddress,
  PENDING_TTL_SECONDS,
  RETENTION_MAX_SECONDS,
  type OrderRecord,
} from "../lib/checkout/address-store";
import { checkoutEligibility, priceCheckFor } from "../lib/checkout/eligibility";
import { analyse } from "../lib/marketplace/anomaly";
import { euroValueCents, prepareCheckout, prepareRefund, walletFunds, MIN_SOL_LAMPORTS } from "../lib/checkout/checkout";
import { OrderMetaStore } from "../lib/reports/order-meta";
import * as orders from "../lib/chains/solana/orders";
import { associatedTokenAddress } from "../lib/chains/solana/spl";
import type { Listing } from "../lib/marketplace/types";
import { decidePayment, readPayment } from "../lib/checkout/payment-status";
import { firstExpiry, readQuote } from "../lib/checkout/quote-public";
import { base58 } from "../app/components/wallet";

/**
 * Checkout moves money and holds personal data, so most of these tests are
 * about the two things that must never happen:
 *
 *   - a shopper charged a price other than the one quoted
 *   - a delivery address kept, exposed, or attached to the wrong order
 */

const ENV = {
  QUOTE_SECRET: "q".repeat(40),
  EUR_USD_RATE: "1.1367",
};
const ADDRESS = { name: "Ada Lovelace", line1: "Hauptstr. 1", postcode: "10115", city: "Berlin", country: "de" };
const LISTING = { source: "ebay", id: "v1|1|0", url: "https://www.ebay.de/itm/1", title: "ThinkPad X1", seller: "laptop_depot", amount: 24900, currency: "EUR" };

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "sigpath-store-"));
  return { dir, store: AddressStore.withKey(dir, randomBytes(32)) };
}

const noFetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Quotes: the price cannot be edited
// ---------------------------------------------------------------------------

test("a signed quote verifies and carries its price", () => {
  const token = signQuote(LISTING, ENV)!;
  const r = verifyQuote(token, ENV);
  assert.ok(r.ok);
  assert.equal(r.ok && r.listing.amount, 24900);
});

test("editing the price in a quote breaks the signature", () => {
  // The attack this exists for: decode, change 24900 to 100, re-encode.
  const token = signQuote(LISTING, ENV)!;
  const [payload, sig] = token.split(".");
  const body = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  body.amount = 100;
  const forged = Buffer.from(JSON.stringify(body)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = verifyQuote(`${forged}.${sig}`, ENV);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "bad_signature");
});

test("a quote signed with a different key is rejected", () => {
  const token = signQuote(LISTING, { QUOTE_SECRET: "x".repeat(40) })!;
  assert.equal(verifyQuote(token, ENV).ok, false);
});

test("a quote expires", () => {
  const now = Date.now();
  const token = signQuote(LISTING, ENV, now)!;
  const r = verifyQuote(token, ENV, now + (QUOTE_TTL_SECONDS + 1) * 1000);
  assert.equal(!r.ok && r.reason, "expired");
});

test("a short QUOTE_SECRET is refused rather than used", () => {
  assert.equal(signQuote(LISTING, { QUOTE_SECRET: "short" }), null);
  assert.equal(verifyQuote("a.b", { QUOTE_SECRET: "short" }).ok, false);
});

test("garbage is malformed, not a crash", () => {
  for (const t of ["", "x", "a.b.c", "..."]) assert.equal(verifyQuote(t, ENV).ok, false);
});

// ---------------------------------------------------------------------------
// Exchange rate and USDC amounts
// ---------------------------------------------------------------------------

test("EUR converts to USDC in integer arithmetic, rounding up", () => {
  const rate = { micro: rateToMicro("1.1367")!, display: "1.1367", source: "test" };
  // 249.00 EUR * 1.1367 = 283.0383 USD
  assert.equal(toUsdcBaseUnits(24900, "EUR", rate), 283_038_300n);
  // A rate that leaves a remainder rounds UP, so escrow never holds less than the price.
  const odd = { micro: rateToMicro("1.000001")!, display: "", source: "" };
  assert.equal(toUsdcBaseUnits(1, "EUR", odd), 10_001n);
});

test("USD needs no rate; other currencies are refused, not guessed", () => {
  assert.equal(toUsdcBaseUnits(100, "USD", null), 1_000_000n);
  assert.equal(toUsdcBaseUnits(100, "EUR", null), null);
  assert.equal(toUsdcBaseUnits(100, "JPY", { micro: 1n, display: "", source: "" }), null);
  assert.equal(toUsdcBaseUnits(0, "USD", null), null);
});

test("the live rate is used and labelled with its source and date", async () => {
  _resetFxCache();
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ date: "2026-09-24", rates: { USD: 1.1367 } }), { status: 200 })) as unknown as typeof fetch;
  const r = await eurUsdRate({}, fetchImpl);
  assert.equal(r?.micro, 1_136_700n);
  assert.match(r!.source, /ECB reference rate, 2026-09-24/);
  _resetFxCache();
});

test("a fallback rate is used only when the live one fails, and says so", async () => {
  _resetFxCache();
  const r = await eurUsdRate({ EUR_USD_RATE: "1.10" }, noFetch);
  assert.equal(r?.micro, 1_100_000n);
  assert.match(r!.source, /fallback/i);
  assert.equal(await eurUsdRate({}, noFetch), null, "no live rate and no fallback means no price");
  _resetFxCache();
});

// ---------------------------------------------------------------------------
// Address validation: only what delivery needs
// ---------------------------------------------------------------------------

test("an address keeps only the delivery fields", () => {
  const r = validateAddress({ ...ADDRESS, email: "ada@example.com", phone: "123" });
  assert.ok(r.ok);
  // Fields nobody asked for are dropped, not stored — a form that grows an
  // email box later does not silently start keeping emails.
  assert.deepEqual(Object.keys(r.ok ? r.address : {}).sort(), ["city", "country", "line1", "name", "postcode"]);
  assert.equal(r.ok && r.address.country, "DE");
});

test("missing, oversized and malformed fields are refused", () => {
  assert.equal(validateAddress({ ...ADDRESS, city: "" }).ok, false);
  assert.equal(validateAddress({ ...ADDRESS, name: "x".repeat(101) }).ok, false);
  assert.equal(validateAddress({ ...ADDRESS, country: "Germany" }).ok, false);
  assert.equal(validateAddress(null).ok, false);
});

test("control characters are stripped", () => {
  const r = validateAddress({ ...ADDRESS, line1: "Haupt\u0000str.\n1" });
  assert.equal(r.ok && r.address.line1, "Haupt str. 1");
});

// ---------------------------------------------------------------------------
// The store: encrypted, bound to its order, write-once, deletable
// ---------------------------------------------------------------------------

const RECORD: OrderRecord = {
  address: { name: "Ada Lovelace", line1: "Hauptstr. 1", postcode: "10115", city: "Berlin", country: "DE" },
  buyer: Keypair.generate().publicKey.toBase58(),
  listing: { ...LISTING },
  usdc: "283038300",
};

test("a record round-trips, and nothing personal is on disk in the clear", async () => {
  const { dir, store } = tmpStore();
  const order = Keypair.generate().publicKey.toBase58();
  await store.put(order, RECORD);
  const got = await store.get(order);
  assert.deepEqual(got?.record, RECORD);
  const raw = readFileSync(join(dir, `${order}.json`), "utf8");
  // Every probe must be unable to appear in base64 or base58 by chance. The
  // file is random-looking ciphertext: a short probe like "Ada" turns up in it
  // roughly one run in 700, which made this test fail on noise, not a leak.
  // Spaces and dots never occur in either alphabet; the rest are long enough.
  for (const leak of ["Ada Lovelace", "Hauptstr. 1", "Berlin", "10115", RECORD.buyer]) {
    assert.ok(!raw.includes(leak), `"${leak}" is readable on disk`);
  }
});

test("an existing record is never overwritten", async () => {
  // Replacing the address on a paid order would redirect someone's parcel.
  const { store } = tmpStore();
  const order = Keypair.generate().publicKey.toBase58();
  await store.put(order, RECORD);
  await assert.rejects(store.put(order, { ...RECORD, address: { ...RECORD.address, city: "Elsewhere" } }));
  assert.equal((await store.get(order))?.record.address.city, "Berlin");
});

test("a record moved onto another order will not decrypt", async () => {
  // The order address is bound in as authenticated data. Swapping files would
  // otherwise ship one person's order to another person's address.
  const { dir, store } = tmpStore();
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  await store.put(a, RECORD);
  renameSync(join(dir, `${a}.json`), join(dir, `${b}.json`));
  await assert.rejects(store.get(b));
});

test("a tampered record will not decrypt", async () => {
  const { dir, store } = tmpStore();
  const order = Keypair.generate().publicKey.toBase58();
  await store.put(order, RECORD);
  const p = join(dir, `${order}.json`);
  const f = JSON.parse(readFileSync(p, "utf8"));
  const ct = Buffer.from(f.ct, "base64");
  ct[0] ^= 1;
  f.ct = ct.toString("base64");
  writeFileSync(p, JSON.stringify(f));
  await assert.rejects(store.get(order));
});

test("an order id cannot be used to escape the store directory", async () => {
  const { store } = tmpStore();
  for (const bad of ["../../etc/passwd", "..", "a/b", "not-base58-0OIl"]) {
    await assert.rejects(store.put(bad, RECORD), /Invalid order id/);
  }
});

test("deleting removes the file", async () => {
  const { dir, store } = tmpStore();
  const order = Keypair.generate().publicKey.toBase58();
  await store.put(order, RECORD);
  assert.equal(await store.delete(order), true);
  assert.equal(readdirSync(dir).length, 0);
  assert.equal(await store.delete(order), false);
});

test("a key that is not 32 bytes is refused", () => {
  assert.equal(AddressStore.fromEnv({ ADDRESS_KEY: Buffer.alloc(16).toString("base64") }), null);
  assert.equal(AddressStore.fromEnv({}), null);
  assert.ok(AddressStore.fromEnv({ ADDRESS_KEY: randomBytes(32).toString("base64"), ADDRESS_STORE_DIR: tmpdir() }));
});

// ---------------------------------------------------------------------------
// Sweep: deletion that does not depend on anyone remembering
// ---------------------------------------------------------------------------

async function seeded(ageSeconds: number) {
  const { store } = tmpStore();
  const order = Keypair.generate().publicKey.toBase58();
  const now = Date.now();
  await store.put(order, RECORD, now - ageSeconds * 1000);
  return { store, order, now };
}

type Status = "funded" | "fulfilled" | "refunded" | "missing" | "unknown";
const always = (s: Status) => async () => s;

test("settled orders lose their address", async () => {
  for (const s of ["fulfilled", "refunded"] as const) {
    const { store, order, now } = await seeded(60);
    const del = await store.sweep(always(s), now);
    assert.deepEqual(del, [{ order, reason: `order ${s}` }]);
  }
});

test("a live order keeps its address", async () => {
  const { store, now } = await seeded(3 * 86400);
  assert.deepEqual(await store.sweep(always("funded"), now), []);
});

test("an abandoned checkout is forgotten after the pending window, not before", async () => {
  const young = await seeded(PENDING_TTL_SECONDS - 60);
  assert.deepEqual(await young.store.sweep(always("missing"), young.now), [], "the payment may still be confirming");
  const old = await seeded(PENDING_TTL_SECONDS + 60);
  assert.equal((await old.store.sweep(always("missing"), old.now))[0]?.reason, "checkout abandoned");
});

test("an RPC outage never deletes an address the operator still needs", async () => {
  const { store, now } = await seeded(5 * 86400);
  assert.deepEqual(await store.sweep(always("unknown"), now), []);
});

test("the retention cap deletes regardless of chain state", async () => {
  // The backstop that makes "we delete it" true rather than usually true: even
  // an order still 'funded', or a chain that cannot be read, cannot keep an
  // address past the longest possible order window.
  for (const s of ["funded", "unknown"] as const) {
    const { store, now } = await seeded(RETENTION_MAX_SECONDS + 60);
    assert.equal((await store.sweep(always(s), now))[0]?.reason, "retention limit reached");
  }
});

// ---------------------------------------------------------------------------
// Eligibility: SigPath won't buy what its own checks flagged
// ---------------------------------------------------------------------------

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "1",
    source: "ebay",
    title: "t",
    url: "https://x",
    price: { amount: 10000, currency: "EUR" },
    shipping: { amount: 500, currency: "EUR" },
    condition: "new",
    seller: { handle: "s" },
    ...over,
  };
}

const CHECKED = { checked: true } as const;

test("a flagged listing gets no checkout", () => {
  const r = checkoutEligibility(listing(), [{ source: "ebay", listingId: "1", kind: "underpriced", message: "m" }], CHECKED);
  assert.equal(r.eligible, false);
});

test("a listing whose price could not be checked gets no checkout", () => {
  // THE GATE IS STRICTER THAN THE WARNINGS. Nothing accuses this listing — it
  // simply could not be compared — and that is exactly where a scam hides when
  // it is SigPath's own money on the line.
  const r = checkoutEligibility(listing(), [], { checked: false, reason: "Too few used listings." });
  assert.equal(r.eligible, false);
  assert.match(!r.eligible ? r.reason : "", /price-check/);
  assert.match(!r.eligible ? r.reason : "", /Too few used listings/);
});

test("unknown shipping blocks checkout rather than under-quoting", () => {
  assert.equal(checkoutEligibility(listing({ shipping: undefined }), [], CHECKED).eligible, false);
});

test("unpayable currencies and mixed-currency shipping are refused", () => {
  assert.equal(
    checkoutEligibility(listing({ price: { amount: 1, currency: "JPY" }, shipping: { amount: 0, currency: "JPY" } }), [], CHECKED).eligible,
    false,
  );
  assert.equal(checkoutEligibility(listing({ shipping: { amount: 1, currency: "USD" } }), [], CHECKED).eligible, false);
});

test("a clean, price-checked EUR listing with known shipping is eligible", () => {
  assert.equal(checkoutEligibility(listing(), [], CHECKED).eligible, true);
});

// ---------------------------------------------------------------------------
// priceCheckFor: was the price actually compared, and if not, why not?
// ---------------------------------------------------------------------------

function used(id: string, amount: number, source: Listing["source"] = "stub"): Listing {
  return listing({ id, source, condition: "used", price: { amount, currency: "EUR" }, seller: { handle: `u${id}` } });
}

test("a used item with enough used comparables is price-checked", () => {
  const ls = [1, 2, 3, 4, 5].map((i) => used(`u${i}`, 5000));
  const a = analyse([{ source: "stub", status: "ok", listings: ls }]);
  assert.deepEqual(priceCheckFor(ls[0], a), { checked: true });
});

test("a used item with too few used comparables is NOT checked, and says why", () => {
  const news = [1, 2, 3, 4, 5].map((i) => listing({ id: `n${i}`, seller: { handle: `n${i}` } }));
  const u = used("u1", 3000);
  const a = analyse([{ source: "stub", status: "ok", listings: [...news, u] }]);
  const r = priceCheckFor(u, a);
  assert.equal(r.checked, false);
  assert.match(!r.checked ? r.reason : "", /enough used listings/);
  // ...and the new ones beside it were checked, so the gate is per listing.
  assert.equal(priceCheckFor(news[0], a).checked, true);
});

test("an item of unknown condition is never checked", () => {
  const ls = [1, 2, 3, 4, 5].map((i) => listing({ id: `n${i}`, seller: { handle: `n${i}` } }));
  const odd = listing({ id: "x", condition: "unknown" });
  const a = analyse([{ source: "stub", status: "ok", listings: [...ls, odd] }]);
  const r = priceCheckFor(odd, a);
  assert.equal(r.checked, false);
  assert.match(!r.checked ? r.reason : "", /condition isn't stated/);
});

test("one marketplace's checked listing cannot vouch for another's with the same id", () => {
  // Keys are source:id. A bare id would let an unchecked listing through the
  // gate just because some other marketplace uses the same number.
  const checkedEbay = [1, 2, 3, 4, 5].map((i) => listing({ id: `${i}`, source: "ebay", seller: { handle: `e${i}` } }));
  const a = analyse([{ source: "ebay", status: "ok", listings: checkedEbay }]);
  const sameIdElsewhere = listing({ id: "1", source: "stub" });
  assert.equal(priceCheckFor(checkedEbay[0], a).checked, true);
  assert.equal(priceCheckFor(sameIdElsewhere, a).checked, false);
});

test("nothing is price-checked while a marketplace is failing", () => {
  const ls = [1, 2, 3, 4, 5].map((i) => listing({ id: `n${i}`, seller: { handle: `n${i}` } }));
  const a = analyse([
    { source: "stub", status: "ok", listings: ls },
    { source: "ebay", status: "timeout", listings: [] },
  ]);
  const r = priceCheckFor(ls[0], a);
  assert.equal(r.checked, false);
  assert.match(!r.checked ? r.reason : "", /isn't responding/);
});

// ---------------------------------------------------------------------------
// prepareCheckout, against a fake connection
// ---------------------------------------------------------------------------

function tokenAccount(amount: bigint | null) {
  if (amount === null) return null;
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data, executable: false, lamports: 1 };
}

/** `eurc` defaults to the same balance as `usdc`, so a test about one coin isn't short of the other. */
function fakeConn(opts: { usdc: bigint | null; eurc?: bigint | null; lamports: number; order?: Buffer | null }): Connection {
  const blockhash = Keypair.generate().publicKey.toBase58();
  return {
    // walletFunds asks for [EURC account, USDC account], in that order.
    getMultipleAccountsInfo: async (pks: PublicKey[]) => pks.map((_, i) => tokenAccount(i === 0 ? (opts.eurc === undefined ? opts.usdc : opts.eurc) : opts.usdc)),
    getAccountInfo: async (pk: PublicKey) => {
      if (opts.order !== undefined && opts.order !== null) {
        return { owner: orders.ORDERS_PROGRAM_ID, data: opts.order, executable: false, lamports: 1 };
      }
      if (opts.usdc === null) return null;
      const data = Buffer.alloc(165);
      data.writeBigUInt64LE(opts.usdc, 64);
      void pk;
      return { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data, executable: false, lamports: 1 };
    },
    getBalance: async () => opts.lamports,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
  } as unknown as Connection;
}

const rich = () => fakeConn({ usdc: 1_000_000_000n, lamports: 1_000_000_000 });

test("a valid checkout returns a transaction for exactly the quoted amount", async () => {
  const { store } = tmpStore();
  const buyer = Keypair.generate().publicKey;
  const r = await prepareCheckout(
    // A fee set on purpose (the default is none), so the arithmetic with one is checked.
    { quote: signQuote(LISTING, { ...ENV, SIGPATH_FEE_BPS: "200" })!, buyer: buyer.toBase58(), address: ADDRESS, token: "USDC" },
    { env: ENV, store, conn: rich(), fetchImpl: noFetch },
  );
  assert.ok(r.ok, !r.ok ? r.error : "");
  if (!r.ok) return;

  // Item 283.0383 USDC (249.00 EUR at 1.1367) + the 2% service fee 5.660766 = 288.699066.
  assert.equal(r.token, "USDC");
  assert.equal(r.feeBaseUnits, "5660766");
  assert.equal(r.baseUnits, "288699066");
  const tx = Transaction.from(Buffer.from(r.transaction, "base64"));
  assert.ok(tx.feePayer?.equals(buyer), "the buyer pays the fee");
  assert.equal(tx.instructions.length, 1);
  const ix = tx.instructions[0];
  assert.ok(ix.programId.equals(orders.ORDERS_PROGRAM_ID));
  assert.equal(ix.data.readBigUInt64LE(16), 288_699_066n, "the amount signed for is the amount quoted, fee included");
  assert.deepEqual(ix.data.subarray(24, 56), orders.listingHash(LISTING), "the order commits to this listing");
  assert.ok(ix.keys[3].pubkey.equals(associatedTokenAddress(buyer, orders.USDC_MINT)));
  assert.ok(ix.keys[4].pubkey.equals(orders.USDC_MINT));
  assert.equal(tx.signatures.every((s) => s.signature === null), true, "the server signs nothing");

  // The address was stored BEFORE the transaction was handed back, with the coin and fee noted for the operator.
  const rec = (await store.get(r.order))?.record;
  assert.equal(rec?.address.city, "Berlin");
  assert.equal(rec?.token, "USDC");
  assert.equal(rec?.amount, "288699066");
  assert.equal(rec?.fee, "5660766");
});

test("a euro price is paid in EURC by default: one to one, no rate, the EURC mint", async () => {
  const { store } = tmpStore();
  const buyer = Keypair.generate().publicKey;
  // No fetch at all: a euro price in EURC needs no exchange rate.
  const r = await prepareCheckout(
    { quote: signQuote(LISTING, ENV)!, buyer: buyer.toBase58(), address: ADDRESS },
    { env: ENV, store, conn: rich(), fetchImpl: (async () => { throw new Error("no rate needed"); }) as unknown as typeof fetch },
  );
  assert.ok(r.ok, !r.ok ? r.error : "");
  if (!r.ok) return;
  assert.equal(r.token, "EURC");
  assert.equal(r.baseUnits, "249000000", "249.00 EUR is 249 EURC");
  assert.equal(r.display, "249.00 EURC");
  assert.equal(r.rate, null);
  const ix = Transaction.from(Buffer.from(r.transaction, "base64")).instructions[0];
  assert.equal(ix.data.readBigUInt64LE(16), 249_000_000n);
  assert.ok(ix.keys[3].pubkey.equals(associatedTokenAddress(buyer, orders.EURC_MINT)), "paid from the buyer's EURC account");
  assert.ok(ix.keys[4].pubkey.equals(orders.EURC_MINT));
  assert.equal((await store.get(r.order))?.record.token, "EURC");
});

test("the shopper can still choose USDC, and an unknown coin falls back to the default", async () => {
  const { store } = tmpStore();
  const buyer = Keypair.generate().publicKey.toBase58();
  const usdc = await prepareCheckout({ quote: signQuote(LISTING, ENV)!, buyer, address: ADDRESS, token: "usdc" }, { env: ENV, store, conn: rich(), fetchImpl: noFetch });
  assert.ok(usdc.ok && usdc.token === "USDC" && usdc.baseUnits === "283038300");
  const odd = await prepareCheckout({ quote: signQuote(LISTING, ENV)!, buyer, address: ADDRESS, token: "DOGE" }, { env: ENV, store, conn: rich(), fetchImpl: noFetch });
  assert.ok(odd.ok && odd.token === "EURC");
});

test("a dollar price in EURC is converted at the same ECB rate, rounded up", () => {
  const rate = { micro: 1_136_700n, display: "1.1367", source: "test" };
  // 100.00 USD / 1.1367 = 87.9739597... EUR -> 87.973960 EURC, rounded up.
  assert.equal(toTokenBaseUnits(10_000, "USD", "EURC", rate), 87_973_960n);
  assert.equal(toTokenBaseUnits(10_000, "USD", "EURC", null), null, "no rate, no price");
  assert.equal(toTokenBaseUnits(24_900, "EUR", "EURC", null), 249_000_000n, "a euro price needs no rate");
  assert.equal(toTokenBaseUnits(24_900, "EUR", "USDC", rate), 283_038_300n, "USDC as before");
});

test("the euro value beside a USDC total: the price it came from, to the cent", () => {
  const rate = { micro: 1_136_700n, display: "1.1367", source: "test" };
  assert.equal(euroValueCents(283_038_300n, "USDC", rate), 24_900, "283.0383 USDC is 249.00 EUR");
  assert.equal(euroValueCents(164_880_000n, "USDC", { micro: 1_099_200n, display: "1.0992", source: "test" }), 15_000, "the friend's 164.88 USDC is 150.00 EUR");
  assert.equal(euroValueCents(249_000_000n, "EURC", null), 24_900);
  assert.equal(euroValueCents(1_000_000n, "USDC", null), null, "no rate: nothing to say");
});

test("the fee is the one signed into the quote, not whatever the setting says at checkout", async () => {
  const { store } = tmpStore();
  const quote = signQuote(LISTING, { ...ENV, SIGPATH_FEE_BPS: "150" })!;
  // The setting changes between the search and the checkout: the shopper still pays what they were shown.
  const r = await prepareCheckout(
    { quote, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS, token: "USDC" },
    { env: { ...ENV, SIGPATH_FEE_BPS: "500" }, store, conn: rich(), fetchImpl: noFetch },
  );
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.feeBaseUnits, "4245575", "1.5% of 283.0383, rounded up");
});

test("a quote from before the fee existed is honoured without one", async () => {
  const { store } = tmpStore();
  // Hand-made: the old format, without feeBps, signed as the old code did.
  const body = Buffer.from(JSON.stringify({ ...LISTING, expiresAt: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  const mac = createHmac("sha256", ENV.QUOTE_SECRET).update("sigpath-quote-v1\n").update(body).digest("base64url");
  const r = await prepareCheckout(
    { quote: `${body}.${mac}`, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS, token: "USDC" },
    { env: ENV, store, conn: rich(), fetchImpl: noFetch },
  );
  assert.ok(r.ok, !r.ok ? r.error : "");
  if (r.ok) {
    assert.equal(r.feeBaseUnits, "0");
    assert.equal(r.baseUnits, "283038300");
  }
});

test("checkout records who the seller was, for fake-product reports later", async () => {
  // The escrow stores only a hash of the listing, and the delivery record is
  // deleted at fulfilment — without this record a report after delivery would
  // have nobody to land on.
  const { store } = tmpStore();
  const metaDir = mkdtempSync(join(tmpdir(), "sigpath-meta-"));
  const metaStore = OrderMetaStore.withKey(metaDir, randomBytes(32));
  const r = await prepareCheckout(
    { quote: signQuote(LISTING, ENV)!, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store, metaStore, conn: rich(), fetchImpl: noFetch },
  );
  assert.ok(r.ok);
  const meta = r.ok ? await metaStore.get(r.order) : null;
  assert.deepEqual(meta?.record.seller, { source: "ebay", handle: "laptop_depot" });
  assert.equal(meta?.record.listing.url, LISTING.url);
});

test("every checkout gets a fresh, unpredictable order address", async () => {
  const { store } = tmpStore();
  const buyer = Keypair.generate().publicKey.toBase58();
  const a = await prepareCheckout({ quote: signQuote(LISTING, ENV)!, buyer, address: ADDRESS }, { env: ENV, store, conn: rich(), fetchImpl: noFetch });
  const b = await prepareCheckout({ quote: signQuote(LISTING, ENV)!, buyer, address: ADDRESS }, { env: ENV, store, conn: rich(), fetchImpl: noFetch });
  assert.ok(a.ok && b.ok && a.order !== b.order);
});

test("a wallet that cannot pay gets a plain message, and no address is stored", async () => {
  // Data minimisation: an order that cannot happen has no reason to hold an address.
  const { dir, store } = tmpStore();
  const r = await prepareCheckout(
    { quote: signQuote(LISTING, ENV)!, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS, token: "USDC" },
    { env: ENV, store, conn: fakeConn({ usdc: 1_000_000n, lamports: 1_000_000_000 }), fetchImpl: noFetch },
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 402);
  assert.match(!r.ok ? r.error : "", /1\.00 USDC/);
  // The page offers to top up exactly the missing amount (MoonPay).
  const needed = Number(!r.ok && r.error.match(/needs ([\d.]+) USDC/)?.[1]);
  assert.ok(!r.ok && Math.abs((r.shortfall ?? 0) - (needed - 1)) < 1e-6);
  assert.equal(!r.ok && r.token, "USDC");
  assert.equal(readdirSync(dir).length, 0);
});

test("a wallet with dollars but no euros is short in EURC, and told so in EURC", async () => {
  const { store } = tmpStore();
  const r = await prepareCheckout(
    { quote: signQuote(LISTING, ENV)!, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store, conn: fakeConn({ usdc: 1_000_000_000n, eurc: null, lamports: 1_000_000_000 }), fetchImpl: noFetch },
  );
  assert.equal(!r.ok && r.status, 402);
  assert.match(!r.ok ? r.error : "", /holds 0\.00 EURC; the order needs 249\.00 EURC/);
  assert.equal(!r.ok && r.shortfall, 249);
});

test("too little SOL for fees and rent is caught before the wallet prompt", async () => {
  const { dir, store } = tmpStore();
  const r = await prepareCheckout(
    { quote: signQuote(LISTING, ENV)!, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store, conn: fakeConn({ usdc: 1_000_000_000n, lamports: MIN_SOL_LAMPORTS - 1 }), fetchImpl: noFetch },
  );
  assert.equal(!r.ok && r.status, 402);
  assert.equal(readdirSync(dir).length, 0);
});

test("a forged quote is refused before anything is stored", async () => {
  const { dir, store } = tmpStore();
  const forged = signQuote({ ...LISTING, amount: 1 }, { QUOTE_SECRET: "attacker".repeat(5) })!;
  const r = await prepareCheckout(
    { quote: forged, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store, conn: rich(), fetchImpl: noFetch },
  );
  assert.equal(!r.ok && r.status, 400);
  assert.equal(readdirSync(dir).length, 0);
});

test("no address store means no checkout at all", async () => {
  const r = await prepareCheckout(
    { quote: signQuote(LISTING, ENV)!, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store: null, conn: rich(), fetchImpl: noFetch },
  );
  assert.equal(!r.ok && r.status, 503);
});

test("if the address cannot be stored, no transaction is handed out", async () => {
  // Otherwise a shopper could pay for an order SigPath has nowhere to ship.
  const broken = { put: async () => { throw new Error("disk full"); } } as unknown as AddressStore;
  const r = await prepareCheckout(
    { quote: signQuote(LISTING, ENV)!, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store: broken, conn: rich(), fetchImpl: noFetch },
  );
  assert.equal(r.ok, false);
  assert.ok(!("transaction" in r));
});

test("an order over the per-order limit is refused", async () => {
  const { store } = tmpStore();
  const big = signQuote({ ...LISTING, amount: 100_000_00, currency: "USD" }, ENV)!; // 100,000.00 USD
  const r = await prepareCheckout(
    { quote: big, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store, conn: rich(), fetchImpl: noFetch },
  );
  assert.equal(!r.ok && r.status, 400);
  assert.match(!r.ok ? r.error : "", /limit/);
});

// ---------------------------------------------------------------------------
// prepareRefund
// ---------------------------------------------------------------------------

function orderAccount(status: number, deadline: number, buyer = Keypair.generate().publicKey): Buffer {
  const b = Buffer.alloc(orders.ORDER_LAYOUT.size);
  orders.ORDER_ACCOUNT_DISCRIMINATOR.copy(b, 0);
  buyer.toBuffer().copy(b, orders.ORDER_LAYOUT.buyer);
  b.writeBigInt64LE(BigInt(deadline), orders.ORDER_LAYOUT.deadline);
  b.writeUInt8(status, orders.ORDER_LAYOUT.status);
  return b;
}

test("a refund is not offered before the deadline, except to the operator", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const conn = fakeConn({ usdc: null, lamports: 0, order: orderAccount(0, nowS + 3600) });
  const order = Keypair.generate().publicKey.toBase58();

  const stranger = await prepareRefund({ order, caller: Keypair.generate().publicKey.toBase58() }, { conn });
  assert.equal(!stranger.ok && stranger.status, 409);

  const op = await prepareRefund({ order, caller: orders.OPERATOR.toBase58() }, { conn });
  assert.ok(op.ok);
});

test("after the deadline anyone gets a refund transaction, paid to the buyer", async () => {
  const buyer = Keypair.generate().publicKey;
  const conn = fakeConn({ usdc: null, lamports: 0, order: orderAccount(0, Math.floor(Date.now() / 1000) - 10, buyer) });
  const caller = Keypair.generate().publicKey;
  const r = await prepareRefund({ order: Keypair.generate().publicKey.toBase58(), caller: caller.toBase58() }, { conn });
  assert.ok(r.ok);
  if (!r.ok) return;
  const ix = Transaction.from(Buffer.from(r.transaction, "base64")).instructions[0];
  assert.ok(ix.keys[3].pubkey.equals(associatedTokenAddress(buyer, orders.USDC_MINT)), "destination is the buyer's own account");
});

test("a settled order offers no refund", async () => {
  const conn = fakeConn({ usdc: null, lamports: 0, order: orderAccount(1, 0) });
  const r = await prepareRefund({ order: Keypair.generate().publicKey.toBase58(), caller: orders.OPERATOR.toBase58() }, { conn });
  assert.equal(!r.ok && r.status, 409);
});

test("the page's balance check reads the buyer's own EURC and USDC accounts and SOL, as the checkout does", async () => {
  const owner = Keypair.generate().publicKey;
  const asked: string[] = [];
  const conn = {
    getMultipleAccountsInfo: async (pks: PublicKey[]) => {
      asked.push(...pks.map((p) => p.toBase58()));
      return [tokenAccount(5_000_000n), tokenAccount(12_340_000n)];
    },
    getBalance: async () => 7_000_000,
  } as unknown as Connection;
  assert.deepEqual(await walletFunds(conn, owner), { balances: { EURC: 5_000_000n, USDC: 12_340_000n }, lamports: 7_000_000 });
  assert.deepEqual(asked, [associatedTokenAddress(owner, orders.EURC_MINT).toBase58(), associatedTokenAddress(owner, orders.USDC_MINT).toBase58()]);
  // No token accounts yet: nothing to pay with, not an error.
  assert.deepEqual(await walletFunds(fakeConn({ usdc: null, lamports: 0 }), owner), { balances: { EURC: 0n, USDC: 0n }, lamports: 0 });
});

// ---------------------------------------------------------------------------
// After the wallet sends: what became of the payment
// ---------------------------------------------------------------------------

test("the checkout says until which block the payment can land, and when a price has run out", async () => {
  const { store } = tmpStore();
  const ok = await prepareCheckout(
    { quote: signQuote(LISTING, ENV)!, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store, conn: rich(), fetchImpl: noFetch },
  );
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.validUntil, 100, "the blockhash's last valid block height");
  const stale = signQuote(LISTING, ENV, Date.now() - (QUOTE_TTL_SECONDS + 60) * 1000)!;
  const r = await prepareCheckout({ quote: stale, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS }, { env: ENV, store, conn: rich(), fetchImpl: noFetch });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.code, "quote_expired", "so the form can offer the current price in place");
});

test("a payment is paid once its order exists, failed when the network refused it, expired once it can't land", () => {
  const base = { orderFound: false, signature: null, blockHeight: 90, validUntil: 100 };
  assert.deepEqual(decidePayment({ ...base, orderFound: true }), { state: "paid" });
  assert.deepEqual(decidePayment({ ...base, orderFound: true, blockHeight: 500 }), { state: "paid" }, "the order is the proof, however late");
  assert.equal(decidePayment({ ...base, signature: { err: { InstructionError: [0, { Custom: 6 }] } } }).state, "failed");
  assert.match(decidePayment({ ...base, signature: { err: { InstructionError: [0, { Custom: 6 }] } } }).reason ?? "", /Custom/);
  assert.equal(decidePayment({ ...base, signature: { err: null } }).state, "pending", "landed: the order is a moment away");
  assert.equal(decidePayment(base).state, "pending", "not seen yet, still time");
  assert.equal(decidePayment({ ...base, blockHeight: 101 }).state, "expired", "past its last block, never seen: nothing was charged");
  assert.equal(decidePayment({ ...base, blockHeight: 101, signature: { err: null } }).state, "pending", "seen on the network: not expired");
  assert.equal(decidePayment({ ...base, blockHeight: 10_000, validUntil: null }).state, "pending", "without the limit, never called expired");
});

test("the network is asked for the height first, then the order and the signature", async () => {
  const calls: string[] = [];
  const conn = (opts: { order: Buffer | null; height: number; status: { err: unknown } | null }) =>
    ({
      getBlockHeight: async () => (calls.push("height"), opts.height),
      getAccountInfo: async () => (calls.push("order"), opts.order ? { owner: orders.ORDERS_PROGRAM_ID, data: opts.order, executable: false, lamports: 1 } : null),
      getSignatureStatuses: async () => (calls.push("signature"), { value: [opts.status] }),
    }) as unknown as Connection;
  const order = Keypair.generate().publicKey;
  const sig = base58(new Uint8Array(64).fill(7));
  const paid = await readPayment(conn({ order: orderAccount(0, 0), height: 50, status: null }), { order, signature: sig, validUntil: 100 });
  assert.equal(paid.state, "paid");
  assert.equal(calls[0], "height", "the height first, so a payment that landed before it is always seen");
  const gone = await readPayment(conn({ order: null, height: 150, status: null }), { order, signature: sig, validUntil: 100 });
  assert.equal(gone.state, "expired");
  calls.length = 0;
  const noSig = await readPayment(conn({ order: null, height: 50, status: null }), { order, signature: null, validUntil: 100 });
  assert.equal(noSig.state, "pending");
  assert.ok(!calls.includes("signature"), "without a signature, only the order and the height");
});

test("signatures are written in base58 as Solana writes them", () => {
  for (const bytes of [new Uint8Array(32).fill(0), new Uint8Array(32).fill(255), Keypair.generate().publicKey.toBytes()]) {
    assert.equal(base58(bytes), new PublicKey(bytes).toBase58());
  }
  assert.equal(base58(new Uint8Array([0, 0, 1])), "112", "leading zero bytes are 1s");
});

test("the browser reads a quote's listing and expiry, and nothing it can't read", () => {
  const token = signQuote({ ...LISTING, title: "ThinkPad X1 – Größe M" }, ENV, 1_800_000_000_000)!;
  assert.deepEqual(readQuote(token), {
    source: "ebay",
    id: "v1|1|0",
    title: "ThinkPad X1 – Größe M",
    url: "https://www.ebay.de/itm/1",
    expiresAt: 1_800_000_000 + QUOTE_TTL_SECONDS,
  });
  assert.equal(readQuote(signQuote({ ...LISTING, url: "javascript:alert(1)" }, ENV)!)?.url, null, "only an https page is offered");
  const later = signQuote(LISTING, ENV, 1_800_000_600_000)!;
  assert.equal(firstExpiry([later, token]), 1_800_000_000 + QUOTE_TTL_SECONDS, "the first to run out");
  assert.equal(readQuote("not a token"), null);
  assert.equal(readQuote("e30.sig"), null, "{} has no listing");
  assert.equal(firstExpiry([]), null);
});
