/**
 * lib/checkout/checkout.ts — turn a signed quote into a transaction to sign.
 *
 * The Solana Pay "transaction request" shape: the server builds the complete,
 * unsigned transaction and the shopper's wallet signs it. The browser never
 * assembles an instruction, so it never chooses the amount, the program, or
 * where the money goes — it can only approve or refuse what the server built,
 * and the wallet shows the shopper exactly that before they approve.
 *
 * Order of operations matters, and is chosen so nothing is ever half-done in
 * the dangerous direction:
 *
 *   1. verify the quote          — price comes from the signature, not the form
 *   2. validate the address      — only the fields delivery needs
 *   3. price in USDC             — at a rate that is shown, never invented
 *   4. check the wallet can pay  — a plain message beats a failed signature
 *   5. build the transaction
 *   6. store the address         — BEFORE returning the transaction
 *
 * Step 6 before handing anything back means an order can never be paid for
 * without an address to ship it to. The reverse failure — an address stored
 * for an order that is never paid — is harmless, and the sweep deletes it
 * after fifteen minutes.
 */

import { randomBytes } from "crypto";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import * as orders from "../chains/solana/orders";
import { associatedTokenAddress, tokenAmountFromData } from "../chains/solana/spl";
import { verifyQuote, type QuotedListing } from "./quote";
import { eurUsdRate, toUsdcBaseUnits, type FxRate } from "./fx";
import { withServiceFee } from "./fee";
import { AddressStore, validateAddress } from "./address-store";
import { OrderMetaStore, type ChainOrderView } from "../reports/order-meta";
import { sellerKey } from "../marketplace/types";

/** How long the operator has to buy and ship before the refund opens. */
export const DEFAULT_WINDOW_SECS = 7 * 24 * 3600;

/**
 * SOL the buyer needs for this transaction: the fee plus rent for the order
 * account and the vault. The vault rent comes back to them at settlement; the
 * order account stays on chain as their public receipt.
 */
export const MIN_SOL_LAMPORTS = 6_000_000;

export function ordersRpcUrl(env: Record<string, string | undefined> = process.env): string {
  return env.ORDERS_RPC_URL?.trim() || env.NEXT_PUBLIC_RPC_URL?.trim() || "https://api.devnet.solana.com";
}

export function checkoutWindowSecs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CHECKOUT_WINDOW_SECS ?? DEFAULT_WINDOW_SECS);
  return Number.isInteger(n) && n >= orders.MIN_WINDOW_SECS && n <= orders.MAX_WINDOW_SECS ? n : DEFAULT_WINDOW_SECS;
}

/** A fresh, unpredictable u64. Also stops anyone pre-computing a vault address to grief. */
export function newNonce(): bigint {
  return randomBytes(8).readBigUInt64LE();
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

export type ChainOrderState =
  | { found: false }
  | ({ found: true } & orders.DecodedOrder);

/**
 * The address exists but is not a SigPath order. Distinct from an RPC failure:
 * nothing went wrong, the caller simply pointed at someone else's account, and
 * the page should say so rather than blame the network.
 */
export class NotAnOrderError extends Error {
  constructor() {
    super("That address is not a SigPath order");
    this.name = "NotAnOrderError";
  }
}

export async function readOrder(conn: Connection, order: PublicKey): Promise<ChainOrderState> {
  const info = await conn.getAccountInfo(order, "confirmed");
  if (!info) return { found: false };
  // Owner first: without it, any account of the right length would decode
  // into a plausible-looking order.
  if (!info.owner.equals(orders.ORDERS_PROGRAM_ID)) throw new NotAnOrderError();
  return { found: true, ...orders.decodeOrder(info.data) };
}

/** For OrderMetaStore.sweep: status AND settlement time, since the report window runs from settlement. */
export function chainStateReader(conn: Connection) {
  return async (order: string): Promise<ChainOrderView> => {
    try {
      const s = await readOrder(conn, new PublicKey(order));
      return s.found ? { status: s.status, settledAt: s.settledAt } : "missing";
    } catch {
      return "unknown";
    }
  };
}

/** For AddressStore.sweep: never throws, maps RPC failure to "unknown". */
export function chainStatusReader(conn: Connection) {
  return async (order: string): Promise<"funded" | "fulfilled" | "refunded" | "missing" | "unknown"> => {
    try {
      const s = await readOrder(conn, new PublicKey(order));
      return s.found ? s.status : "missing";
    } catch {
      return "unknown";
    }
  };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface PreparedCheckout {
  ok: true;
  /** Unsigned transaction, base64. The wallet signs and sends it. */
  transaction: string;
  order: string;
  /** Total the escrow takes: item + service fee. */
  usdcBaseUnits: string;
  usdcDisplay: string;
  /** The service fee within the total. */
  feeBaseUnits: string;
  rate: FxRate | null;
  windowSecs: number;
  listing: QuotedListing;
}

export interface CheckoutError {
  ok: false;
  /** HTTP status the route should answer with. */
  status: number;
  error: string;
  /** When the wallet is short of USDC: how much more it needs, in whole USDC. */
  shortfallUsdc?: number;
}

export async function prepareCheckout(
  input: { quote: unknown; buyer: unknown; address: unknown },
  deps: {
    env?: Record<string, string | undefined>;
    conn?: Connection;
    store?: AddressStore | null;
    metaStore?: OrderMetaStore | null;
    /** Sellers with upheld fake-product reports, by sellerKey. */
    upheldReports?: ReadonlyMap<string, number>;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): Promise<PreparedCheckout | CheckoutError> {
  const env = deps.env ?? process.env;
  const store = deps.store === undefined ? AddressStore.fromEnv(env) : deps.store;
  const metaStore = deps.metaStore === undefined ? OrderMetaStore.fromEnv(env) : deps.metaStore;
  if (!store) {
    // Without a key there is nowhere safe to put an address. Refuse to take
    // money for an order that could not be shipped.
    return { ok: false, status: 503, error: "Checkout is not configured (ADDRESS_KEY)." };
  }

  // 1. quote
  if (typeof input.quote !== "string") return { ok: false, status: 400, error: "Missing quote." };
  const q = verifyQuote(input.quote, env, deps.now);
  if (!q.ok) {
    const messages: Record<string, string> = {
      expired: "This price has expired. Search again to get a current price.",
      bad_signature: "This price could not be verified.",
      malformed: "This price could not be read.",
      not_configured: "Checkout is not configured (QUOTE_SECRET).",
    };
    return { ok: false, status: q.reason === "not_configured" ? 503 : 400, error: messages[q.reason] };
  }
  const listing = q.listing;

  // Re-checked HERE, not only when the pay button was drawn: a quote lives
  // thirty minutes, and a report upheld in that time must still stop SigPath
  // paying this seller.
  if ((deps.upheldReports?.get(sellerKey(listing.source, listing.seller)) ?? 0) > 0) {
    return {
      ok: false,
      status: 409,
      error: "SigPath no longer buys from this seller: a verified buyer's fake-product report against them was upheld.",
    };
  }

  // 2. buyer and address
  let buyer: PublicKey;
  try {
    buyer = new PublicKey(String(input.buyer));
  } catch {
    return { ok: false, status: 400, error: "Invalid wallet address." };
  }
  const addr = validateAddress(input.address);
  if (!addr.ok) return { ok: false, status: 400, error: addr.error };

  // 3. price in USDC
  const rate = listing.currency.toUpperCase() === "USD" ? null : await eurUsdRate(env, deps.fetchImpl);
  const itemUsdc = toUsdcBaseUnits(listing.amount, listing.currency, rate);
  if (itemUsdc === null) {
    return {
      ok: false,
      status: listing.currency.toUpperCase() === "EUR" ? 503 : 400,
      error:
        listing.currency.toUpperCase() === "EUR"
          ? "No exchange rate is available right now, so this cannot be priced in USDC."
          : `Listings priced in ${listing.currency} cannot be paid in USDC yet.`,
    };
  }
  // SigPath's service fee, at the rate signed into the quote, goes into the
  // escrow with the price: paid out on fulfilment, refunded with it otherwise.
  const { fee: feeUsdc, total: usdc } = withServiceFee(itemUsdc, listing.feeBps ?? 0);
  if (usdc > orders.MAX_AMOUNT) {
    return { ok: false, status: 400, error: `This costs ${orders.formatUsdc(usdc)}, over the ${orders.formatUsdc(orders.MAX_AMOUNT)} per-order limit.` };
  }

  // 4. can this wallet pay?
  const conn = deps.conn ?? new Connection(ordersRpcUrl(env), "confirmed");
  const buyerToken = associatedTokenAddress(buyer, orders.USDC_MINT);
  const [tokenInfo, lamports] = await Promise.all([conn.getAccountInfo(buyerToken), conn.getBalance(buyer)]);
  const have = tokenAmountFromData(tokenInfo?.data) ?? 0n;
  if (have < usdc) {
    return {
      ok: false,
      status: 402,
      shortfallUsdc: Number(usdc - have) / 10 ** orders.USDC_DECIMALS,
      error: `This wallet holds ${orders.formatUsdc(have)}; the order needs ${orders.formatUsdc(usdc)}.`,
    };
  }
  if (lamports < MIN_SOL_LAMPORTS) {
    return {
      ok: false,
      status: 402,
      error: `This wallet needs about ${(MIN_SOL_LAMPORTS / 1e9).toFixed(3)} SOL for fees and account rent.`,
    };
  }

  // 5. build
  const nonce = newNonce();
  const [order] = orders.orderPda(buyer, nonce);
  const windowSecs = checkoutWindowSecs(env);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: buyer, blockhash, lastValidBlockHeight }).add(
    orders.createOrderIx({
      buyer,
      nonce,
      amount: usdc,
      listingHash: orders.listingHash(listing),
      windowSecs,
      buyerToken,
    }),
  );

  // 6a. record who the seller was — kept for the report window after
  // fulfilment, so a fake-product report can land on the right seller. Stored
  // BEFORE the address: if this fails nothing is stored at all; if the address
  // then fails, this record is orphaned and the sweep removes it.
  if (metaStore) {
    try {
      await metaStore.put(
        order.toBase58(),
        {
          buyer: buyer.toBase58(),
          seller: { source: listing.source, handle: listing.seller },
          listing: {
            source: listing.source,
            id: listing.id,
            url: listing.url,
            title: listing.title,
            amount: listing.amount,
            currency: listing.currency,
          },
        },
        deps.now,
      );
    } catch {
      return { ok: false, status: 500, error: "Could not record the order; nothing was charged." };
    }
  }

  // 6b. store the address — before the transaction leaves the server
  try {
    await store.put(
      order.toBase58(),
      {
        address: addr.address,
        buyer: buyer.toBase58(),
        listing: {
          source: listing.source,
          id: listing.id,
          url: listing.url,
          title: listing.title,
          amount: listing.amount,
          currency: listing.currency,
        },
        usdc: usdc.toString(),
        feeUsdc: feeUsdc.toString(),
      },
      deps.now,
    );
  } catch {
    return { ok: false, status: 500, error: "Could not record the delivery address; nothing was charged." };
  }

  return {
    ok: true,
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    order: order.toBase58(),
    usdcBaseUnits: usdc.toString(),
    usdcDisplay: orders.formatUsdc(usdc),
    feeBaseUnits: feeUsdc.toString(),
    rate,
    windowSecs,
    listing,
  };
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

/** Build an unsigned refund transaction for `caller` to sign, if a refund is currently possible. */
export async function prepareRefund(
  input: { order: unknown; caller: unknown },
  deps: { env?: Record<string, string | undefined>; conn?: Connection; now?: number } = {},
): Promise<{ ok: true; transaction: string } | CheckoutError> {
  let order: PublicKey;
  let caller: PublicKey;
  try {
    order = new PublicKey(String(input.order));
    caller = new PublicKey(String(input.caller));
  } catch {
    return { ok: false, status: 400, error: "Invalid address." };
  }

  const conn = deps.conn ?? new Connection(ordersRpcUrl(deps.env ?? process.env), "confirmed");
  const state = await readOrder(conn, order);
  if (!state.found) return { ok: false, status: 404, error: "No such order." };
  if (state.status !== "funded") return { ok: false, status: 409, error: `This order is already ${state.status}.` };

  const nowS = Math.floor((deps.now ?? Date.now()) / 1000);
  if (nowS <= state.deadline && !caller.equals(orders.OPERATOR)) {
    // Checked here for a friendly message; the PROGRAM enforces it regardless.
    return { ok: false, status: 409, error: "The refund opens when the fulfilment deadline passes." };
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: caller, blockhash, lastValidBlockHeight }).add(
    orders.refundIx({ caller, order, buyer: state.buyer }),
  );
  return { ok: true, transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
}
