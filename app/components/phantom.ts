"use client";

/**
 * app/components/phantom.ts — the three wallet calls the checkout needs.
 *
 * Talks to Phantom's injected provider directly rather than pulling in the
 * wallet-adapter packages: connect, sign-and-send, and nothing else. Every
 * transaction arrives already built by the server (see lib/checkout), so the
 * page never assembles an instruction — the wallet shows the shopper exactly
 * what the server built, and they approve or refuse it.
 *
 * Phantom sends to whichever network IT is set to. On devnet, the shopper has
 * to switch Phantom to Devnet (Settings -> Developer Settings -> Testnet Mode),
 * or the transaction goes to mainnet, where the program does not exist.
 */

import { Transaction } from "@solana/web3.js";

export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
  /**
   * Sign a plain-text message — NOT a transaction. Used to prove "I am the
   * wallet that paid for this order" without moving anything. Phantom shows the
   * text to the user before they sign, which is why the report message spells
   * out exactly what it is for.
   */
  signMessage(message: Uint8Array, display?: "utf8" | "hex"): Promise<{ signature: Uint8Array }>;
}

/** Signature bytes -> base64 for the server, without Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
}

/** Base64 from the server -> a Transaction the wallet can sign. No Buffer needed. */
export function txFromBase64(b64: string): Transaction {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Transaction.from(bytes);
}

/** Wait until the server can see the order in the given state, or give up. */
export async function waitForOrder(
  order: string,
  want: (s: { found?: boolean; status?: string }) => boolean,
  timeoutMs = 60_000,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`/api/orders/${order}`, { cache: "no-store" });
      if (want(await res.json())) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Wallet errors are objects with a message, not always Errors. */
export function walletErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
