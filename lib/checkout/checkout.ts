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
 *   5. build the transaction     (one escrow order per item: a cart pays for several at once)
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

/**
 * What a wallet can pay with: its USDC (base units, 0 without a token account)
 * and its SOL. The checkout and the page's balance check read it the same way,
 * so the page never says "enough" where the checkout will say "short".
 */
export async function walletFunds(conn: Connection, owner: PublicKey): Promise<{ usdc: bigint; lamports: number }> {
  const [tokenInfo, lamports] = await Promise.all([
    conn.getAccountInfo(associatedTokenAddress(owner, orders.USDC_MINT)),
    conn.getBalance(owner),
  ]);
  return { usdc: tokenAmountFromData(tokenInfo?.data) ?? 0n, lamports };
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

/** One order of a cart checkout. */
export interface PreparedOrder {
  order: string;
  usdcBaseUnits: string;
  usdcDisplay: string;
  feeBaseUnits: string;
  listing: QuotedListing;
}

/** Several orders, one transaction, one wallet approval: a cart. */
export interface PreparedCartCheckout {
  ok: true;
  transaction: string;
  orders: PreparedOrder[];
  totalBaseUnits: string;
  totalDisplay: string;
  rate: FxRate | null;
  windowSecs: number;
}

export interface CheckoutError {
  ok: false;
  /** HTTP status the route should answer with. */
  status: number;
  error: string;
  /** When the wallet is short of USDC: how much more it needs, in whole USDC. */
  shortfallUsdc?: number;
}

/**
 * Items one cart payment can carry. Each is its own escrow order (its own
 * account, vault and refund), so one late delivery refunds that item alone;
 * the limit is what fits in one Solana transaction with room to spare.
 */
export const MAX_CART_ORDERS = 4;
/** Solana's limit on a serialized transaction. */
const TX_MAX_BYTES = 1232;

type CheckoutDeps = {
  env?: Record<string, string | undefined>;
  conn?: Connection;
  store?: AddressStore | null;
  metaStore?: OrderMetaStore | null;
  /** Sellers with upheld fake-product reports, by sellerKey. */
  upheldReports?: ReadonlyMap<string, number>;
  fetchImpl?: typeof fetch;
  now?: number;
};

export async function prepareCheckout(
  input: { quote: unknown; buyer: unknown; address: unknown },
  deps: CheckoutDeps = {},
): Promise<PreparedCheckout | CheckoutError> {
  const r = await prepareOrders({ quotes: [input.quote], buyer: input.buyer, address: input.address }, deps);
  if (!r.ok) return r;
  const o = r.orders[0];
  return {
    ok: true,
    transaction: r.transaction,
    order: o.order,
    usdcBaseUnits: o.usdcBaseUnits,
    usdcDisplay: o.usdcDisplay,
    feeBaseUnits: o.feeBaseUnits,
    rate: r.rate,
    windowSecs: r.windowSecs,
    listing: o.listing,
  };
}

/** A cart: up to MAX_CART_ORDERS signed quotes, paid with one approval. */
export async function prepareCartCheckout(
  input: { quotes: unknown; buyer: unknown; address: unknown },
  deps: CheckoutDeps = {},
): Promise<PreparedCartCheckout | CheckoutError> {
  if (!Array.isArray(input.quotes) || input.quotes.length === 0) return { ok: false, status: 400, error: "Nothing to pay for." };
  if (input.quotes.length > MAX_CART_ORDERS) {
    return { ok: false, status: 400, error: `One payment covers up to ${MAX_CART_ORDERS} items. Pay for the rest in a second payment.` };
  }
  return prepareOrders({ quotes: input.quotes, buyer: input.buyer, address: input.address }, deps);
}

/** Step 1, shared by the payment and its invoice: every quote verified, no item twice, no penalised seller. */
function verifyQuotes(quotes: unknown[], env: Record<string, string | undefined>, deps: CheckoutDeps): { ok: true; listings: QuotedListing[] } | CheckoutError {
  const many = quotes.length > 1;
  const listings: QuotedListing[] = [];
  for (const quote of quotes) {
    if (typeof quote !== "string") return { ok: false, status: 400, error: "Missing quote." };
    const q = verifyQuote(quote, env, deps.now);
    if (!q.ok) {
      const messages: Record<string, string> = {
        expired: many ? "A price in your cart has expired. Check the prices again." : "This price has expired. Search again to get a current price.",
        bad_signature: "This price could not be verified.",
        malformed: "This price could not be read.",
        not_configured: "Checkout is not configured (QUOTE_SECRET).",
      };
      return { ok: false, status: q.reason === "not_configured" ? 503 : 400, error: messages[q.reason] };
    }
    if (listings.some((l) => l.source === q.listing.source && l.id === q.listing.id)) {
      return { ok: false, status: 400, error: "The same item is in this payment twice." };
    }
    // Re-checked HERE, not only when the pay button was drawn: a quote lives
    // thirty minutes, and a report upheld in that time must still stop SigPath
    // paying this seller.
    if ((deps.upheldReports?.get(sellerKey(q.listing.source, q.listing.seller)) ?? 0) > 0) {
      return {
        ok: false,
        status: 409,
        error: `SigPath no longer buys from ${many ? `the seller of "${q.listing.title}"` : "this seller"}: a verified buyer's fake-product report against them was upheld.`,
      };
    }
    listings.push(q.listing);
  }
  return { ok: true, listings };
}

/**
 * Step 3, shared by the payment and its invoice: each item in USDC at one
 * rate, plus the service fee signed into its quote. The invoice can't show a
 * number the payment wouldn't charge.
 */
async function priceListings(
  listings: QuotedListing[],
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; rate: FxRate | null; priced: { listing: QuotedListing; item: bigint; usdc: bigint; fee: bigint }[]; total: bigint } | CheckoutError> {
  const many = listings.length > 1;
  const rate = listings.every((l) => l.currency.toUpperCase() === "USD") ? null : await eurUsdRate(env, fetchImpl);
  const priced: { listing: QuotedListing; item: bigint; usdc: bigint; fee: bigint }[] = [];
  for (const listing of listings) {
    const usd = listing.currency.toUpperCase() === "USD";
    const itemUsdc = toUsdcBaseUnits(listing.amount, listing.currency, usd ? null : rate);
    if (itemUsdc === null) {
      return {
        ok: false,
        status: listing.currency.toUpperCase() === "EUR" ? 503 : 400,
        error:
          listing.currency.toUpperCase() === "EUR"
            ? `No exchange rate is available right now, so ${many ? "these" : "this"} cannot be priced in USDC.`
            : `Listings priced in ${listing.currency} cannot be paid in USDC yet.`,
      };
    }
    // SigPath's service fee, at the rate signed into the quote, goes into the
    // escrow with the price: paid out on fulfilment, refunded with it otherwise.
    const { fee, total } = withServiceFee(itemUsdc, listing.feeBps ?? 0);
    if (total > orders.MAX_AMOUNT) {
      return {
        ok: false,
        status: 400,
        error: `${many ? `"${listing.title}" costs` : "This costs"} ${orders.formatUsdc(total)}, over the ${orders.formatUsdc(orders.MAX_AMOUNT)} per-order limit.`,
      };
    }
    priced.push({ listing, item: itemUsdc, usdc: total, fee });
  }
  return { ok: true, rate, priced, total: priced.reduce((t, x) => t + x.usdc, 0n) };
}

/** One line of the invoice shown before (and after) paying. */
export interface InvoiceLine {
  source: string;
  id: string;
  title: string;
  url: string;
  /** The listing's price including shipping, in its own currency (minor units). */
  amount: number;
  currency: string;
  /** In USDC base units: the item, the service fee, and the two together. */
  itemUsdc: string;
  feeUsdc: string;
  totalUsdc: string;
  feeBps: number;
}

export interface Invoice {
  ok: true;
  lines: InvoiceLine[];
  totalUsdc: string;
  totalDisplay: string;
  /** Per currency, in minor units: what the items cost before conversion. */
  localTotals: { amount: number; currency: string }[];
  rate: { display: string; source: string } | null;
}

/** The invoice for these quotes: what's being bought, and every conversion to USDC. Charges nothing. */
export async function invoiceFor(quotes: unknown, deps: CheckoutDeps = {}): Promise<Invoice | CheckoutError> {
  const env = deps.env ?? process.env;
  if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > MAX_CART_ORDERS) {
    return { ok: false, status: 400, error: "Nothing to show." };
  }
  const v = verifyQuotes(quotes, env, deps);
  if (!v.ok) return v;
  const p = await priceListings(v.listings, env, deps.fetchImpl);
  if (!p.ok) return p;
  const local = new Map<string, number>();
  for (const l of v.listings) local.set(l.currency, (local.get(l.currency) ?? 0) + l.amount);
  return {
    ok: true,
    lines: p.priced.map((x) => ({
      source: x.listing.source,
      id: x.listing.id,
      title: x.listing.title,
      url: x.listing.url,
      amount: x.listing.amount,
      currency: x.listing.currency,
      itemUsdc: x.item.toString(),
      feeUsdc: x.fee.toString(),
      totalUsdc: x.usdc.toString(),
      feeBps: x.listing.feeBps ?? 0,
    })),
    totalUsdc: p.total.toString(),
    totalDisplay: orders.formatUsdc(p.total),
    localTotals: [...local].map(([currency, amount]) => ({ currency, amount })),
    rate: p.rate ? { display: p.rate.display, source: p.rate.source } : null,
  };
}

async function prepareOrders(
  input: { quotes: unknown[]; buyer: unknown; address: unknown },
  deps: CheckoutDeps,
): Promise<PreparedCartCheckout | CheckoutError> {
  const env = deps.env ?? process.env;
  const store = deps.store === undefined ? AddressStore.fromEnv(env) : deps.store;
  const metaStore = deps.metaStore === undefined ? OrderMetaStore.fromEnv(env) : deps.metaStore;
  if (!store) {
    // Without a key there is nowhere safe to put an address. Refuse to take
    // money for an order that could not be shipped.
    return { ok: false, status: 503, error: "Checkout is not configured (ADDRESS_KEY)." };
  }
  const many = input.quotes.length > 1;

  // 1. quotes
  const verified = verifyQuotes(input.quotes, env, deps);
  if (!verified.ok) return verified;
  const listings = verified.listings;

  // 2. buyer and address
  let buyer: PublicKey;
  try {
    buyer = new PublicKey(String(input.buyer));
  } catch {
    return { ok: false, status: 400, error: "Invalid wallet address." };
  }
  const addr = validateAddress(input.address);
  if (!addr.ok) return { ok: false, status: 400, error: addr.error };

  // 3. prices in USDC, at one rate for the whole payment
  const p = await priceListings(listings, env, deps.fetchImpl);
  if (!p.ok) return p;
  const { rate, priced, total } = p;

  // 4. can this wallet pay for all of it?
  const conn = deps.conn ?? new Connection(ordersRpcUrl(env), "confirmed");
  const buyerToken = associatedTokenAddress(buyer, orders.USDC_MINT);
  const { usdc: have, lamports } = await walletFunds(conn, buyer);
  if (have < total) {
    return {
      ok: false,
      status: 402,
      shortfallUsdc: Number(total - have) / 10 ** orders.USDC_DECIMALS,
      error: `This wallet holds ${orders.formatUsdc(have)}; ${many ? "these orders need" : "the order needs"} ${orders.formatUsdc(total)}.`,
    };
  }
  // Each order pays rent for its own account and vault.
  const needLamports = MIN_SOL_LAMPORTS * priced.length;
  if (lamports < needLamports) {
    return {
      ok: false,
      status: 402,
      error: `This wallet needs about ${(needLamports / 1e9).toFixed(3)} SOL for fees and account rent.`,
    };
  }

  // 5. build: one escrow order per item, all in one transaction
  const windowSecs = checkoutWindowSecs(env);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: buyer, blockhash, lastValidBlockHeight });
  const built = priced.map((p) => {
    const nonce = newNonce();
    const [order] = orders.orderPda(buyer, nonce);
    tx.add(
      orders.createOrderIx({
        buyer,
        nonce,
        amount: p.usdc,
        listingHash: orders.listingHash(p.listing),
        windowSecs,
        buyerToken,
      }),
    );
    return { ...p, order };
  });
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (serialized.length > TX_MAX_BYTES) {
    return { ok: false, status: 400, error: "Too many items for one payment. Pay for fewer at a time." };
  }

  // 6. record each order, BEFORE the transaction leaves the server. Per order:
  // who the seller was first (kept for the report window after fulfilment, so a
  // fake-product report can land on the right seller), then the address. If
  // anything fails, nothing is returned, so nothing can be paid; what was
  // already stored is orphaned and the sweep removes it.
  for (const b of built) {
    const listing = {
      source: b.listing.source,
      id: b.listing.id,
      url: b.listing.url,
      title: b.listing.title,
      amount: b.listing.amount,
      currency: b.listing.currency,
    };
    if (metaStore) {
      try {
        await metaStore.put(
          b.order.toBase58(),
          { buyer: buyer.toBase58(), seller: { source: b.listing.source, handle: b.listing.seller }, listing },
          deps.now,
        );
      } catch {
        return { ok: false, status: 500, error: "Could not record the order; nothing was charged." };
      }
    }
    try {
      await store.put(
        b.order.toBase58(),
        { address: addr.address, buyer: buyer.toBase58(), listing, usdc: b.usdc.toString(), feeUsdc: b.fee.toString() },
        deps.now,
      );
    } catch {
      return { ok: false, status: 500, error: "Could not record the delivery address; nothing was charged." };
    }
  }

  return {
    ok: true,
    transaction: serialized.toString("base64"),
    orders: built.map((b) => ({
      order: b.order.toBase58(),
      usdcBaseUnits: b.usdc.toString(),
      usdcDisplay: orders.formatUsdc(b.usdc),
      feeBaseUnits: b.fee.toString(),
      listing: b.listing,
    })),
    totalBaseUnits: total.toString(),
    totalDisplay: orders.formatUsdc(total),
    rate,
    windowSecs,
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
