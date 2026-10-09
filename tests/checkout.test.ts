import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readdirSync, renameSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { signQuote, verifyQuote, QUOTE_TTL_SECONDS } from "../lib/checkout/quote";
import { eurUsdRate, rateToMicro, toUsdcBaseUnits, _resetFxCache } from "../lib/checkout/fx";
import {
  AddressStore,
  validateAddress,
  PENDING_TTL_SECONDS,
  RETENTION_MAX_SECONDS,
  type OrderRecord,
} from "../lib/checkout/address-store";
import { checkoutEligibility, priceCheckFor } from "../lib/checkout/eligibility";
import { analyse } from "../lib/marketplace/anomaly";
import { prepareCheckout, prepareRefund, MIN_SOL_LAMPORTS } from "../lib/checkout/checkout";
import { OrderMetaStore } from "../lib/reports/order-meta";
import * as orders from "../lib/chains/solana/orders";
import { associatedTokenAddress } from "../lib/chains/solana/spl";
import type { Listing } from "../lib/marketplace/types";

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

function fakeConn(opts: { usdc: bigint | null; lamports: number; order?: Buffer | null }): Connection {
  const blockhash = Keypair.generate().publicKey.toBase58();
  return {
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
    { quote: signQuote(LISTING, ENV)!, buyer: buyer.toBase58(), address: ADDRESS },
    { env: ENV, store, conn: rich(), fetchImpl: noFetch },
  );
  assert.ok(r.ok, !r.ok ? r.error : "");
  if (!r.ok) return;

  assert.equal(r.usdcBaseUnits, "283038300");
  const tx = Transaction.from(Buffer.from(r.transaction, "base64"));
  assert.ok(tx.feePayer?.equals(buyer), "the buyer pays the fee");
  assert.equal(tx.instructions.length, 1);
  const ix = tx.instructions[0];
  assert.ok(ix.programId.equals(orders.ORDERS_PROGRAM_ID));
  assert.equal(ix.data.readBigUInt64LE(16), 283_038_300n, "the amount signed for is the amount quoted");
  assert.deepEqual(ix.data.subarray(24, 56), orders.listingHash(LISTING), "the order commits to this listing");
  assert.ok(ix.keys[3].pubkey.equals(associatedTokenAddress(buyer, orders.USDC_MINT)));
  assert.equal(tx.signatures.every((s) => s.signature === null), true, "the server signs nothing");

  // The address was stored BEFORE the transaction was handed back.
  assert.equal((await store.get(r.order))?.record.address.city, "Berlin");
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
    { quote: signQuote(LISTING, ENV)!, buyer: Keypair.generate().publicKey.toBase58(), address: ADDRESS },
    { env: ENV, store, conn: fakeConn({ usdc: 1_000_000n, lamports: 1_000_000_000 }), fetchImpl: noFetch },
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 402);
  assert.match(!r.ok ? r.error : "", /1\.00 USDC/);
  // The page offers to top up exactly the missing amount (MoonPay).
  const needed = Number(!r.ok && r.error.match(/needs ([\d.]+) USDC/)?.[1]);
  assert.ok(!r.ok && Math.abs((r.shortfallUsdc ?? 0) - (needed - 1)) < 1e-6);
  assert.equal(readdirSync(dir).length, 0);
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
