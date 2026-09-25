import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as o from "../lib/chains/solana/orders";
import { associatedTokenAddress, tokenAmountFromData } from "../lib/chains/solana/spl";

/**
 * The client and the program share no generated code — the toolchain cannot
 * produce an IDL (README, trap #3) — so nothing but these tests keeps them in
 * step. Each one reads programs/sigpath_orders/src/lib.rs and checks the
 * client's hand-written mirror against it. A reordered error enum or a changed
 * constant fails HERE, instead of as a wrong error message, or a transaction
 * the program rejects, in front of a shopper.
 *
 * The behaviour itself — escrow, refunds, the attacks — is proven against a
 * live validator by scripts/orders-roundtrip.ts.
 */

const RUST = readFileSync("programs/sigpath_orders/src/lib.rs", "utf8");

function rustConst(name: string): string {
  const m = new RegExp(`pub const ${name}: [^=]+= ([^;]+);`).exec(RUST);
  if (!m) throw new Error(`const ${name} not found in lib.rs`);
  return m[1].trim();
}

function rustPubkey(name: string): string {
  const m = /pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(rustConst(name));
  if (!m) throw new Error(`const ${name} is not a pubkey! literal`);
  return m[1];
}

// ---------------------------------------------------------------------------
// The mirror: constants
// ---------------------------------------------------------------------------

test("the client's program id matches declare_id!", () => {
  const m = /declare_id!\("([^"]+)"\)/.exec(RUST)!;
  assert.equal(o.ORDERS_PROGRAM_ID.toBase58(), m[1]);
});

test("OPERATOR, USDC_MINT and the token program match the program", () => {
  assert.equal(o.OPERATOR.toBase58(), rustPubkey("OPERATOR"));
  assert.equal(o.USDC_MINT.toBase58(), rustPubkey("USDC_MINT"));
  assert.equal(rustPubkey("TOKEN_PROGRAM_ID"), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
});

test("the window and amount limits match the program", () => {
  assert.equal(String(o.MIN_WINDOW_SECS), rustConst("MIN_WINDOW_SECS"));
  assert.equal(o.MAX_WINDOW_SECS, 30 * 24 * 3600);
  assert.equal(rustConst("MAX_WINDOW_SECS"), "30 * 24 * 3600");
  assert.equal(o.MAX_AMOUNT, 1_000n * 1_000_000n);
  assert.equal(rustConst("MAX_AMOUNT"), "1_000 * 1_000_000");
  assert.equal(String(o.USDC_DECIMALS), rustConst("USDC_DECIMALS"));
});

test("the error list is in exactly the program's declaration order", () => {
  // Codes are 6000 + position. One enum variant inserted in the middle of the
  // Rust list and every later error would be reported as the wrong one.
  const block = /pub enum OrdersError \{([\s\S]*?)\n\}/.exec(RUST)![1];
  const names = [...block.matchAll(/^\s*([A-Z][A-Za-z]+),\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(names, [...o.ORDERS_ERRORS]);
});

test("status values match the program", () => {
  assert.equal(String(o.ORDER_STATUS.funded), rustConst("STATUS_FUNDED"));
  assert.equal(String(o.ORDER_STATUS.fulfilled), rustConst("STATUS_FULFILLED"));
  assert.equal(String(o.ORDER_STATUS.refunded), rustConst("STATUS_REFUNDED"));
});

// ---------------------------------------------------------------------------
// The mirror: account order and encodings
// ---------------------------------------------------------------------------

/** Field names of a #[derive(Accounts)] struct, in declaration order. */
function accountsStruct(name: string): string[] {
  const block = new RegExp(`pub struct ${name}<'info> \\{([\\s\\S]*?)\\n\\}`).exec(RUST)![1];
  return [...block.matchAll(/pub (\w+): /g)].map((m) => m[1]);
}

test("instruction account order matches each Accounts struct", () => {
  // The client passes accounts by POSITION. If the struct is reordered and
  // the client is not, every account lands in the wrong slot.
  assert.deepEqual(accountsStruct("CreateOrder"), [
    "buyer", "order", "vault", "buyer_token", "mint", "token_program", "system_program",
  ]);
  assert.deepEqual(accountsStruct("Fulfil"), [
    "operator", "order", "buyer", "vault", "operator_token", "mint", "token_program",
  ]);
  assert.deepEqual(accountsStruct("Refund"), [
    "caller", "order", "buyer", "buyer_token", "vault", "mint", "token_program",
  ]);

  const buyer = Keypair.generate().publicKey;
  const ix = o.createOrderIx({ buyer, nonce: 7n, amount: 1n, listingHash: Buffer.alloc(32, 1), windowSecs: 3600 });
  const [order] = o.orderPda(buyer, 7n);
  assert.ok(ix.keys[0].pubkey.equals(buyer) && ix.keys[0].isSigner && ix.keys[0].isWritable);
  assert.ok(ix.keys[1].pubkey.equals(order));
  assert.ok(ix.keys[2].pubkey.equals(o.vaultPda(order)[0]));
  assert.ok(ix.keys[3].pubkey.equals(associatedTokenAddress(buyer, o.USDC_MINT)));
  assert.ok(ix.keys[4].pubkey.equals(o.USDC_MINT));
});

test("create_order encodes to the program's argument layout", () => {
  const buyer = Keypair.generate().publicKey;
  const hash = Buffer.alloc(32, 0xab);
  const ix = o.createOrderIx({ buyer, nonce: 0x0102030405060708n, amount: 5_000_000n, listingHash: hash, windowSecs: 86400 });
  const d = ix.data;
  assert.equal(d.length, 64);
  assert.deepEqual(d.subarray(0, 8), createHash("sha256").update("global:create_order").digest().subarray(0, 8));
  assert.equal(d.readBigUInt64LE(8), 0x0102030405060708n);
  assert.equal(d.readBigUInt64LE(16), 5_000_000n);
  assert.deepEqual(d.subarray(24, 56), hash);
  assert.equal(d.readBigInt64LE(56), 86400n);
});

test("the order PDA uses the nonce little-endian, matching to_le_bytes()", () => {
  const buyer = Keypair.generate().publicKey;
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(300n);
  const expected = PublicKey.findProgramAddressSync([Buffer.from("order"), buyer.toBuffer(), le], o.ORDERS_PROGRAM_ID)[0];
  assert.ok(o.orderPda(buyer, 300n)[0].equals(expected));
});

test("the client refuses out-of-range orders before they cost a fee", () => {
  const buyer = Keypair.generate().publicKey;
  const base = { buyer, nonce: 1n, listingHash: Buffer.alloc(32), windowSecs: 3600 };
  assert.throws(() => o.createOrderIx({ ...base, amount: 0n }), /Amount/);
  assert.throws(() => o.createOrderIx({ ...base, amount: o.MAX_AMOUNT + 1n }), /Amount/);
  assert.throws(() => o.createOrderIx({ ...base, amount: 1n, windowSecs: 59 }), /Window/);
  assert.throws(() => o.createOrderIx({ ...base, amount: 1n, listingHash: Buffer.alloc(31) }), /32 bytes/);
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function fakeOrder(status: number): Buffer {
  const b = Buffer.alloc(o.ORDER_LAYOUT.size);
  o.ORDER_ACCOUNT_DISCRIMINATOR.copy(b, 0);
  Keypair.generate().publicKey.toBuffer().copy(b, o.ORDER_LAYOUT.buyer);
  b.writeBigUInt64LE(9n, o.ORDER_LAYOUT.nonce);
  b.writeBigUInt64LE(5_000_000n, o.ORDER_LAYOUT.amount);
  b.writeBigInt64LE(1_790_000_000n, o.ORDER_LAYOUT.deadline);
  b.writeUInt8(status, o.ORDER_LAYOUT.status);
  return b;
}

test("an order account decodes by the program's layout", () => {
  const d = o.decodeOrder(fakeOrder(1));
  assert.equal(d.nonce, 9n);
  assert.equal(d.amount, 5_000_000n);
  assert.equal(d.deadline, 1_790_000_000);
  assert.equal(d.status, "fulfilled");
});

test("the layout size matches 8 + INIT_SPACE", () => {
  // buyer 32, nonce 8, amount 8, listing_hash 32, created_at 8, deadline 8,
  // status 1, fulfilment_ref 32, settled_at 8, bump 1, vault_bump 1
  assert.equal(o.ORDER_LAYOUT.size, 8 + 32 + 8 + 8 + 32 + 8 + 8 + 1 + 32 + 8 + 1 + 1);
});

test("an account that is not an Order is refused, not misread", () => {
  const b = fakeOrder(0);
  b[0] ^= 0xff;
  assert.throws(() => o.decodeOrder(b), /discriminator/);
});

test("an unknown status byte is refused", () => {
  assert.throws(() => o.decodeOrder(fakeOrder(9)), /Unknown order status/);
});

// ---------------------------------------------------------------------------
// Money, commitments, errors
// ---------------------------------------------------------------------------

test("USDC amounts parse without float arithmetic", () => {
  assert.equal(o.usdcToBaseUnits("12.34"), 12_340_000n);
  assert.equal(o.usdcToBaseUnits("0.000001"), 1n);
  assert.equal(o.usdcToBaseUnits("100"), 100_000_000n);
  assert.throws(() => o.usdcToBaseUnits("1.2345678"));
  assert.throws(() => o.usdcToBaseUnits("-1"));
  assert.equal(o.formatUsdc(12_340_000n), "12.34 USDC");
  // Exact, not truncated: the page must show what the wallet charges.
  assert.equal(o.formatUsdc(155_727_900n), "155.7279 USDC");
  assert.equal(o.formatUsdc(1n), "0.000001 USDC");
  assert.equal(o.formatUsdc(5_000_000n), "5.00 USDC");
});

test("the listing commitment covers source, id and URL", () => {
  const a = o.listingHash({ source: "ebay", id: "1", url: "https://e/1" });
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, o.listingHash({ source: "etsy", id: "1", url: "https://e/1" }));
  assert.notDeepEqual(a, o.listingHash({ source: "ebay", id: "2", url: "https://e/1" }));
});

test("an empty fulfilment reference is refused", () => {
  // The program rejects an all-zero reference; the client refuses to hash
  // nothing into something that looks like a real one.
  assert.throws(() => o.fulfilmentRefHash("   "), /required/);
});

test("program errors are named from the runtime's log line", () => {
  const err = new Error("Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1777");
  assert.equal(o.ordersErrorName(err), "RefundNotToBuyer"); // 6007
  assert.equal(o.ordersErrorName(new Error("custom program error: 0x7d6")), "ConstraintSeeds"); // 2006
  assert.equal(o.ordersErrorName(new Error("blockhash not found")), null);
});

test("token balances read from raw account data", () => {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(7_000_001n, 64);
  assert.equal(tokenAmountFromData(data), 7_000_001n);
  assert.equal(tokenAmountFromData(null), null);
});
