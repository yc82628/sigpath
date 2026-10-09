import { test } from "node:test";
import assert from "node:assert";
import { Keypair } from "@solana/web3.js";
import { moonPayBuyUrl, moonPayConfig, moonPaySignature } from "../lib/onramp/moonpay";

const testKeys = { MOONPAY_PUBLISHABLE_KEY: "pk_test_abc", MOONPAY_SECRET_KEY: "sk_test_xyz" };
const devnet = { NEXT_PUBLIC_RPC_URL: "https://api.devnet.solana.com" };
const mainnet = { NEXT_PUBLIC_RPC_URL: "https://api.mainnet-beta.solana.com" };

test("the signature matches MoonPay's own worked example", () => {
  // From MoonPay's URL-signing docs: the query string with its leading "?".
  const query = "?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";
  assert.equal(moonPaySignature(query, "sk_test_DocsVector00"), "oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=");
  assert.throws(() => moonPaySignature(query.slice(1), "sk_test_DocsVector00"), /leading \?/);
});

test("test keys work on devnet; live keys only when the escrow is on mainnet", () => {
  const t = moonPayConfig({ ...testKeys, ...devnet })!;
  assert.equal(t.base, "https://buy-sandbox.moonpay.com");
  assert.equal(t.test, true);
  assert.equal(t.currencyCode, "usdc_sol");

  const live = { MOONPAY_PUBLISHABLE_KEY: "pk_live_abc", MOONPAY_SECRET_KEY: "sk_live_xyz" };
  // Real USDC to a wallet whose escrow only takes devnet USDC: refused.
  assert.equal(moonPayConfig({ ...live, ...devnet }), null);
  assert.equal(moonPayConfig({ ...live, ...mainnet })!.base, "https://buy.moonpay.com");

  // Mixed or missing keys: off.
  assert.equal(moonPayConfig({ MOONPAY_PUBLISHABLE_KEY: "pk_test_a", MOONPAY_SECRET_KEY: "sk_live_b", ...mainnet }), null);
  assert.equal(moonPayConfig({ MOONPAY_PUBLISHABLE_KEY: "pk_test_a", ...devnet }), null);
  assert.equal(moonPayConfig({ ...testKeys, ...devnet, MOONPAY_CURRENCY_CODE: "usdc&x=1" }), null);
});

test("the buy link pre-fills the shopper's wallet, USDC on Solana, the amount and euros, and is signed", () => {
  const cfg = moonPayConfig({ ...testKeys, ...devnet })!;
  const wallet = Keypair.generate().publicKey.toBase58();
  const url = new URL(moonPayBuyUrl(cfg, { wallet, usdc: 4.36254, redirectUrl: "https://sigpath.vercel.app/checkout?quote=a.b" }));
  const p = url.searchParams;
  assert.equal(url.origin, "https://buy-sandbox.moonpay.com");
  assert.equal(p.get("apiKey"), "pk_test_abc");
  assert.equal(p.get("currencyCode"), "usdc_sol");
  assert.equal(p.get("baseCurrencyCode"), "eur");
  assert.equal(p.get("walletAddress"), wallet);
  assert.equal(p.get("quoteCurrencyAmount"), "4.37", "a shortfall is rounded UP to the cent");
  assert.equal(p.get("redirectURL"), "https://sigpath.vercel.app/checkout?quote=a.b");

  // The signature covers exactly what is sent, so changing the wallet breaks it.
  const sent = url.search.slice(0, url.search.indexOf("&signature="));
  assert.equal(p.get("signature"), moonPaySignature(sent, "sk_test_xyz"));
  const swapped = sent.replace(wallet, Keypair.generate().publicKey.toBase58());
  assert.notEqual(moonPaySignature(swapped, "sk_test_xyz"), p.get("signature"));
  // The secret key is never in the link.
  assert.ok(!url.toString().includes("sk_test_xyz"));
});

test("only a Solana wallet address is accepted", () => {
  const cfg = moonPayConfig({ ...testKeys, ...devnet })!;
  assert.throws(() => moonPayBuyUrl(cfg, { wallet: "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe" }));
  assert.throws(() => moonPayBuyUrl(cfg, { wallet: "" }));
});
