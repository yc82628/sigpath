import { test } from "node:test";
import assert from "node:assert";
import nacl from "tweetnacl";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CHALLENGE_SECONDS,
  SESSION_SECONDS,
  challenge,
  sessionCookie,
  sessionWallet,
  signIn,
  signInConfigured,
  siteFrom,
} from "../lib/account/session";
import { buyerFilters, ordersForBuyer, refundOpen } from "../lib/account/orders";
import { EURC_MINT, ORDER_ACCOUNT_DISCRIMINATOR, ORDER_LAYOUT, ORDER_STATUS, ORDERS_PROGRAM_ID } from "../lib/chains/solana/orders";

const env = { QUOTE_SECRET: "x".repeat(40) };
const SITE = "sigpath.vercel.app";
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

function sign(kp: Keypair, message: string): string {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)).toString("base64");
}

function asked(kp: Keypair, now = T0, site = SITE) {
  const c = challenge({ wallet: kp.publicKey.toBase58(), site }, { env, now });
  assert.ok(c.ok);
  return c;
}

test("sign-in: a wallet that signs the text gets a session for itself", () => {
  const kp = Keypair.generate();
  const c = asked(kp);
  assert.match(c.message, /Site: sigpath\.vercel\.app/);
  assert.match(c.message, new RegExp(`Wallet: ${kp.publicKey.toBase58()}`));
  assert.match(c.message, /nothing is sent or paid/);
  const r = signIn({ token: c.token, signature: sign(kp, c.message), site: SITE }, { env, now: T0 + 30_000 });
  assert.ok(r.ok);
  assert.equal(r.wallet, kp.publicKey.toBase58());
  assert.equal(r.maxAge, SESSION_SECONDS);
  assert.equal(sessionWallet(r.session, { env, now: T0 + 60_000 }), kp.publicKey.toBase58());
});

test("sign-in: another wallet's signature, a changed token, an old request or another site are refused", () => {
  const kp = Keypair.generate();
  const other = Keypair.generate();
  const c = asked(kp);
  const good = sign(kp, c.message);

  const wrongKey = signIn({ token: c.token, signature: sign(other, c.message), site: SITE }, { env, now: T0 });
  assert.equal(wrongKey.ok, false);
  assert.equal(!wrongKey.ok && wrongKey.status, 403);

  // Claim the other wallet in the token: the MAC no longer matches.
  const [body, mac] = c.token.split(".");
  const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  const forged = Buffer.from(JSON.stringify({ ...payload, w: other.publicKey.toBase58() })).toString("base64url");
  assert.equal(signIn({ token: `${forged}.${mac}`, signature: good, site: SITE }, { env, now: T0 }).ok, false);

  const late = signIn({ token: c.token, signature: good, site: SITE }, { env, now: T0 + CHALLENGE_SECONDS * 1000 + 1 });
  assert.equal(late.ok, false);
  assert.match(!late.ok ? late.error : "", /expired/);

  const elsewhere = signIn({ token: c.token, signature: good, site: "evil.example" }, { env, now: T0 });
  assert.equal(elsewhere.ok, false);

  assert.equal(signIn({ token: c.token, signature: "AAAA", site: SITE }, { env, now: T0 }).ok, false, "a short signature");
  assert.equal(signIn({ token: "nonsense", signature: good, site: SITE }, { env, now: T0 }).ok, false);
});

test("sign-in: a signature over a different text doesn't count", () => {
  const kp = Keypair.generate();
  const c = asked(kp);
  const r = signIn({ token: c.token, signature: sign(kp, c.message.replace("Nonce", "Nonse")), site: SITE }, { env, now: T0 });
  assert.equal(r.ok, false);
});

test("session: expires, can't be altered, and a sign-in token isn't a session", () => {
  const kp = Keypair.generate();
  const c = asked(kp);
  const r = signIn({ token: c.token, signature: sign(kp, c.message), site: SITE }, { env, now: T0 });
  assert.ok(r.ok);
  assert.equal(sessionWallet(r.session, { env, now: T0 + SESSION_SECONDS * 1000 + 1000 }), null, "expired");
  assert.equal(sessionWallet(r.session.slice(0, -2) + "xx", { env, now: T0 }), null, "altered");
  assert.equal(sessionWallet(c.token, { env, now: T0 }), null, "the challenge token is sealed with another key");
  assert.equal(sessionWallet(r.session, { env: { QUOTE_SECRET: "y".repeat(40) }, now: T0 }), null, "another server's secret");
  assert.equal(sessionWallet(undefined, { env }), null);
});

test("sign-in: off without a long enough secret; bad wallets and sites refused", () => {
  assert.equal(signInConfigured({}), false);
  assert.equal(signInConfigured({ QUOTE_SECRET: "short" }), false);
  assert.equal(signInConfigured(env), true);
  const off = challenge({ wallet: Keypair.generate().publicKey.toBase58(), site: SITE }, { env: {} });
  assert.equal(!off.ok && off.status, 503);
  assert.equal(challenge({ wallet: "not-a-wallet", site: SITE }, { env }).ok, false);
  assert.equal(siteFrom("SigPath.Vercel.App"), "sigpath.vercel.app");
  assert.equal(siteFrom("localhost:3000"), "localhost:3000");
  assert.equal(siteFrom("evil.example/path"), null);
  assert.equal(siteFrom(null), null);
});

test("session cookie: HttpOnly and SameSite always, Secure on HTTPS", () => {
  const c = sessionCookie("abc", 60, true);
  assert.match(c, /^sigpath-wallet=abc; /);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(sessionCookie("abc", 60, false), /Secure/);
  assert.match(sessionCookie("", 0, true), /Max-Age=0/);
});

/** An order account's bytes, laid out as the program writes them. */
function orderAccount(buyer: PublicKey, status: keyof typeof ORDER_STATUS, createdAt: number, amount = 78_680_000n) {
  const b = Buffer.alloc(ORDER_LAYOUT.size);
  ORDER_ACCOUNT_DISCRIMINATOR.copy(b, 0);
  buyer.toBuffer().copy(b, ORDER_LAYOUT.buyer);
  b.writeBigUInt64LE(1n, ORDER_LAYOUT.nonce);
  b.writeBigUInt64LE(amount, ORDER_LAYOUT.amount);
  b.writeBigInt64LE(BigInt(createdAt), ORDER_LAYOUT.createdAt);
  b.writeBigInt64LE(BigInt(createdAt + 7 * 86400), ORDER_LAYOUT.deadline);
  b.writeUInt8(ORDER_STATUS[status], ORDER_LAYOUT.status);
  return b;
}

test("my orders: filtered on chain to this buyer, newest first, others and junk skipped", async () => {
  const me = Keypair.generate().publicKey;
  const someoneElse = Keypair.generate().publicKey;
  const filters = buyerFilters(me);
  // No size filter: orders since EURC are 32 bytes longer, and both are this buyer's.
  assert.ok(!filters.some((f) => "dataSize" in f));
  assert.deepEqual(filters[1], { memcmp: { offset: ORDER_LAYOUT.buyer, bytes: me.toBase58() } });

  let asked: { program?: string; filters?: unknown } = {};
  const accounts = [
    { pubkey: Keypair.generate().publicKey, account: { data: orderAccount(me, "fulfilled", 1_000) } },
    { pubkey: Keypair.generate().publicKey, account: { data: orderAccount(me, "funded", 3_000) } },
    // Paid in EURC: the coin follows the record.
    { pubkey: Keypair.generate().publicKey, account: { data: Buffer.concat([orderAccount(me, "refunded", 2_500, 150_000_000n), EURC_MINT.toBuffer()]) } },
    { pubkey: Keypair.generate().publicKey, account: { data: orderAccount(someoneElse, "funded", 2_000) } },
    { pubkey: Keypair.generate().publicKey, account: { data: Buffer.alloc(ORDER_LAYOUT.size) } },
  ];
  const conn = {
    getProgramAccounts: async (program: PublicKey, config: { filters: unknown }) => {
      asked = { program: program.toBase58(), filters: config.filters };
      return accounts;
    },
  } as unknown as Parameters<typeof ordersForBuyer>[0];

  const got = await ordersForBuyer(conn, me);
  assert.equal(asked.program, ORDERS_PROGRAM_ID.toBase58());
  assert.deepEqual(asked.filters, filters);
  assert.deepEqual(got.map((o) => [o.status, o.createdAt, o.token]), [["funded", 3_000, "USDC"], ["refunded", 2_500, "EURC"], ["fulfilled", 1_000, "USDC"]]);
  assert.equal(got[0].address, accounts[1].pubkey.toBase58());
  assert.equal(got[0].amount, 78_680_000n);
  assert.equal(got[1].amount, 150_000_000n);
});

test("my orders: the refund is open only for an unfulfilled order past its deadline", () => {
  assert.equal(refundOpen({ status: "funded", deadline: 100 }, 101), true);
  assert.equal(refundOpen({ status: "funded", deadline: 100 }, 100), false);
  assert.equal(refundOpen({ status: "fulfilled", deadline: 100 }, 500), false);
  assert.equal(refundOpen({ status: "refunded", deadline: 100 }, 500), false);
});
