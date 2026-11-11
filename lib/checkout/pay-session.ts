/**
 * lib/checkout/pay-session.ts — paying by scanning a QR code with a phone wallet.
 *
 * WHY
 * Most people's Solana wallet is the Phantom or Solflare app on their phone,
 * not an extension in the computer's browser. Solana Pay's "transaction
 * request" (docs.solanapay.com) is made for that: the checkout shows a QR code
 * holding `solana:https://…/api/pay/<session>`; the wallet app scans it, asks
 * that address for a label (GET), sends its own account (POST), and gets back
 * the transaction to approve. The server builds it exactly as the browser
 * checkout does (prepareCartCheckout), for whichever wallet scanned.
 *
 * WHAT IS KEPT, AND HOW LONG
 * Until a phone scans, SigPath doesn't know the buyer, so the order can't be
 * named yet: the signed prices and the delivery address are kept as one
 * session, encrypted with ADDRESS_KEY (as every address is), for at most
 * fifteen minutes, the same limit as an unpaid checkout. On the scan, the
 * orders are created and their addresses stored as usual, and the session is
 * deleted: the address then lives only where every order's does.
 *
 * What the page asks while it waits (which orders the scan created, or why it
 * failed) is kept apart, with no address in it, under the same fifteen minutes.
 */

import { randomBytes } from "crypto";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";
import type { Kv } from "../kv/upstash";
import { UpstashKv } from "../kv/upstash";
import { backendFromEnv, EncryptedStore, keyFromEnv, type RecordBackend } from "./encrypted-store";
import type { ShippingAddress } from "./address-store";
import { dataDir } from "../data-dir";

/** How long a QR code can be scanned: the same fifteen minutes an unpaid checkout's address is kept. */
export const PAY_SESSION_SECS = 15 * 60;

export interface PaySessionRecord {
  quotes: string[];
  address: ShippingAddress;
}

/** What the waiting page may know: no address, only what the scan did. */
export type ScanState =
  | { state: "scanned"; orders: { order: string; source: string; id: string; title: string }[]; validUntil: number; buyer: string }
  | { state: "failed"; message: string; shortfallUsdc?: number };

/** A session's id: 32 random bytes, written as a Solana address so the encrypted store accepts it as a key. */
export function newSessionId(): string {
  return new PublicKey(randomBytes(32)).toBase58();
}

export class PaySessionStore extends EncryptedStore<PaySessionRecord> {
  static fromEnv(env: Record<string, string | undefined> = process.env): PaySessionStore | null {
    const key = keyFromEnv(env);
    if (!key) return null;
    const backend: RecordBackend = backendFromEnv(env, {
      defaultDir: join(dataDir(env), "pay-sessions"),
      namespace: "pay-session",
      ttlSecs: PAY_SESSION_SECS,
    });
    return new PaySessionStore(backend, key, "pay-session");
  }

  /** A session that has run out is as good as gone, also where the files backend can't expire it. */
  async live(id: string, now = Date.now()): Promise<PaySessionRecord | null> {
    let found: Awaited<ReturnType<PaySessionStore["get"]>>;
    try {
      found = await this.get(id);
    } catch {
      return null; // not a session id, or not ours to decrypt
    }
    if (!found) return null;
    if (Math.floor(now / 1000) - found.createdAt > PAY_SESSION_SECS) {
      await this.delete(id).catch(() => undefined);
      return null;
    }
    return found.record;
  }
}

/** Where the scan's outcome waits for the page: the database, or this server's memory (local runs). */
const memory = new Map<string, { value: ScanState; until: number }>();

export class ScanStates {
  constructor(private readonly kv: Kv | null) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): ScanStates {
    return new ScanStates(UpstashKv.fromEnv(env));
  }

  private key(id: string) {
    return `sigpath:pay-scan:${id}`;
  }

  async set(id: string, value: ScanState, now = Date.now()): Promise<void> {
    if (this.kv) await this.kv.command(["SET", this.key(id), JSON.stringify(value), "EX", PAY_SESSION_SECS]);
    else memory.set(id, { value, until: now + PAY_SESSION_SECS * 1000 });
  }

  async get(id: string, now = Date.now()): Promise<ScanState | null> {
    if (this.kv) {
      const raw = await this.kv.command<string | null>(["GET", this.key(id)]);
      return raw ? (JSON.parse(raw) as ScanState) : null;
    }
    const m = memory.get(id);
    return m && m.until > now ? m.value : null;
  }
}
