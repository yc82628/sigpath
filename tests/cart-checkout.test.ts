import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { signQuote } from "../lib/checkout/quote";
import { AddressStore } from "../lib/checkout/address-store";
import { prepareCartCheckout, MAX_CART_ORDERS, MIN_SOL_LAMPORTS } from "../lib/checkout/checkout";
import * as orders from "../lib/chains/solana/orders";
import { checkoutCandidates, quoteFresh, setBought, setQuote, type CartItem } from "../lib/cart/cart";
import { requoteItem, type RequoteDeps } from "../lib/cart/requote";
import type { Listing } from "../lib/marketplace/types";
import type { SearchResponse } from "../lib/marketplace/search";

/** The cart's checkout: one transaction, one escrow order per item, every rule of the single checkout per item. */

const ENV = { QUOTE_SECRET: "q".repeat(40), EUR_USD_RATE: "1.1367" };
const ADDRESS = { name: "Ada Lovelace", line1: "Hauptstr. 1", postcode: "10115", city: "Berlin", country: "de" };
const listing = (n: number, amount = 10000) => ({
  source: "ebay",
  id: `v1|${100000000000 + n}|0`,
  url: `https://www.ebay.de/itm/${n}`,
  title: `Item ${n}`,
  seller: `seller_${n}`,
  amount,
  currency: "EUR",
});
const noFetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

function conn(usdc: bigint, lamports = 1_000_000_000): Connection {
  const blockhash = Keypair.generate().publicKey.toBase58();
  return {
    getAccountInfo: async () => {
      const data = Buffer.alloc(165);
      data.writeBigUInt64LE(usdc, 64);
      return { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data, executable: false, lamports: 1 };
    },
    getBalance: async () => lamports,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
  } as unknown as Connection;
}
const store = () => AddressStore.withKey(mkdtempSync(join(tmpdir(), "sigpath-cart-")), randomBytes(32));

test("a cart of four pays in one transaction: one escrow order per item, each with the address stored first", async () => {
  const s = store();
  const buyer = Keypair.generate().publicKey;
  const quotes = [1, 2, 3, 4].map((n) => signQuote(listing(n, 10000 * n), ENV)!);
  const r = await prepareCartCheckout({ quotes, buyer: buyer.toBase58(), address: ADDRESS }, { env: ENV, store: s, metaStore: null, conn: conn(10_000_000_000n), fetchImpl: noFetch });
  assert.ok(r.ok, !r.ok ? r.error : "");
  if (!r.ok) return;
  const tx = Transaction.from(Buffer.from(r.transaction, "base64"));
  assert.equal(tx.instructions.length, 4, "four orders");
  assert.ok(tx.instructions.every((ix) => ix.programId.equals(orders.ORDERS_PROGRAM_ID)));
  assert.equal(new Set(r.orders.map((o) => o.order)).size, 4, "each its own order account");
  assert.ok(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232, "fits one Solana transaction");
  assert.equal(tx.signatures.every((x) => x.signature === null), true, "the server signs nothing");
  // Every order's amount is its own quote's price plus fee, and the total is their sum.
  const amounts = tx.instructions.map((ix) => ix.data.readBigUInt64LE(16));
  assert.deepEqual(amounts.map(String), r.orders.map((o) => o.usdcBaseUnits));
  assert.equal(amounts.reduce((a, b) => a + b, 0n).toString(), r.totalBaseUnits);
  for (const o of r.orders) {
    const rec = (await s.get(o.order))?.record;
    assert.equal(rec?.address.city, "Berlin", "every order has the delivery address");
    assert.equal(rec?.listing.id, o.listing.id, "and its own listing");
  }
});

test("the wallet must cover the whole cart, and SOL for every order's rent", async () => {
  const quotes = [1, 2].map((n) => signQuote(listing(n), ENV)!);
  const buyer = Keypair.generate().publicKey.toBase58();
  const short = await prepareCartCheckout({ quotes, buyer, address: ADDRESS }, { env: ENV, store: store(), metaStore: null, conn: conn(150_000_000n), fetchImpl: noFetch });
  assert.equal(short.ok, false);
  assert.match(!short.ok ? short.error : "", /these orders need/);
  assert.ok(!short.ok && short.shortfallUsdc! > 0);
  const noSol = await prepareCartCheckout({ quotes, buyer, address: ADDRESS }, { env: ENV, store: store(), metaStore: null, conn: conn(10_000_000_000n, MIN_SOL_LAMPORTS * 2 - 1), fetchImpl: noFetch });
  assert.equal(noSol.ok, false, "rent for two orders, not one");
});

test("refused: more than the limit, the same item twice, an expired price, an upheld report", async () => {
  const buyer = Keypair.generate().publicKey.toBase58();
  const deps = { env: ENV, store: store(), metaStore: null, conn: conn(10_000_000_000n), fetchImpl: noFetch };
  const many = Array.from({ length: MAX_CART_ORDERS + 1 }, (_, i) => signQuote(listing(i), ENV)!);
  assert.match(((await prepareCartCheckout({ quotes: many, buyer, address: ADDRESS }, deps)) as { error: string }).error, /up to 4 items/);
  const q = signQuote(listing(1), ENV)!;
  assert.match(((await prepareCartCheckout({ quotes: [q, q], buyer, address: ADDRESS }, deps)) as { error: string }).error, /twice/);
  const old = signQuote(listing(2), ENV, Date.now() - 60 * 60 * 1000)!;
  assert.match(((await prepareCartCheckout({ quotes: [q, old], buyer, address: ADDRESS }, deps)) as { error: string }).error, /expired/);
  const upheld = new Map([["ebay:seller_2", 1]]);
  const r = await prepareCartCheckout({ quotes: [q, signQuote(listing(2), ENV)!], buyer, address: ADDRESS }, { ...deps, upheldReports: upheld });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /Item 2/, "says which item");
  assert.match(((await prepareCartCheckout({ quotes: [], buyer, address: ADDRESS }, deps)) as { error: string }).error, /Nothing to pay/);
});

const cartItem = (n: number, over: Partial<CartItem> = {}): CartItem => ({
  key: `ebay:v1|${100000000000 + n}|0`, source: "ebay", id: `v1|${100000000000 + n}|0`, title: `ThinkPad X1 #${n}`,
  url: `https://www.ebay.de/itm/${n}`, condition: "used", seller: "s", price: { amount: 30000, currency: "EUR" },
  verdict: "checked", headline: "SigPath-checked", addedAt: 0, ...over,
});

test("the cart offers its checked items to the checkout; bought and flagged ones stay out", () => {
  const cart = [cartItem(1), cartItem(2, { verdict: "caution" }), cartItem(3, { source: "aliexpress", key: "aliexpress:x", id: "x" }), cartItem(4)];
  assert.deepEqual(checkoutCandidates(cart).map((c) => c.key), [cartItem(1).key, cartItem(4).key]);
  assert.deepEqual(checkoutCandidates(setBought(cart, cartItem(1).key, true)).map((c) => c.key), [cartItem(4).key]);
  const withQuote = setQuote(cart, cartItem(1).key, { token: "t", expiresAt: 10 * 60 * 1000 });
  assert.equal(quoteFresh(withQuote[0], 0), true);
  assert.equal(quoteFresh(withQuote[0], 8 * 60 * 1000), false, "less than three minutes left: check again");
});

test("checking again signs a new quote only if the listing is still in today's results and still passes", async () => {
  const l: Listing = { id: "v1|100000000001|0", source: "ebay", title: "ThinkPad X1 Carbon", url: "https://www.ebay.de/itm/1", price: { amount: 30000, currency: "EUR" }, shipping: { amount: 0, currency: "EUR" }, condition: "used", seller: { handle: "s" } };
  const result = (listed: Listing[], checked: boolean): SearchResponse =>
    ({
      query: "ThinkPad X1 Carbon",
      listings: listed,
      sources: [],
      linkOut: [],
      analysis: { status: "ok", flags: [], priceChecked: checked ? [`ebay:${l.id}`] : [], coverage: ["ebay"], notConfigured: [], excludedFromComparison: [], comparisons: {}, currency: "EUR" },
    }) as unknown as SearchResponse;
  const deps = (r: SearchResponse): RequoteDeps => ({ search: async () => ({ result: r, isVerified: () => false, flagsExtra: () => {} }), rate: async () => null, now: () => Date.now() });
  const item = { source: "ebay", id: l.id, title: l.title };
  assert.equal((await requoteItem(item, deps(result([], true)), ENV)).ok, false, "not in today's results");
  const ok = await requoteItem(item, deps(result([l], true)), ENV);
  assert.ok(ok.ok, !ok.ok ? ok.reason : "");
  if (ok.ok) assert.ok(ok.token.includes("."), "a signed quote");
  const notChecked = await requoteItem(item, deps(result([l], false)), ENV);
  assert.equal(notChecked.ok, false, "no longer compared: no quote");
  assert.equal((await requoteItem({ source: "aliexpress", id: "1", title: "x" }, deps(result([], true)), ENV)).ok, false);
});
