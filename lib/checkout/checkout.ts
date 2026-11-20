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
 *   3. price in the coin chosen  — EURC one to one for euros; USDC at a rate that is shown, never invented
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
import { eurUsdRate, needsRate, toTokenBaseUnits, usdcInEuroCents, type FxRate } from "./fx";
import { defaultPayToken, parsePayToken, type PayToken } from "../chains/solana/tokens";
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
 * What a wallet can pay with: its EURC and USDC (base units, 0 without a token
 * account) and its SOL. The checkout and the page's balance check read it the
 * same way, so the page never says "enough" where the checkout will say "short".
 */
export async function walletFunds(conn: Connection, owner: PublicKey): Promise<{ balances: Record<PayToken, bigint>; lamports: number }> {
  const [infos, lamports] = await Promise.all([
    conn.getMultipleAccountsInfo([associatedTokenAddress(owner, orders.EURC_MINT), associatedTokenAddress(owner, orders.USDC_MINT)]),
    conn.getBalance(owner),
  ]);
  return {
    balances: { EURC: tokenAmountFromData(infos[0]?.data) ?? 0n, USDC: tokenAmountFromData(infos[1]?.data) ?? 0n },
    lamports,
  };
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
  /** The coin paid in. */
  token: PayToken;
  /** Total the escrow takes: item + service fee, in base units of `token`. */
  baseUnits: string;
  display: string;
  /** The service fee within the total. */
  feeBaseUnits: string;
  rate: FxRate | null;
  windowSecs: number;
  /** The transaction's last valid block height: past it, it can never land (payment-status.ts). */
  validUntil: number;
  listing: QuotedListing;
}

/** One order of a cart checkout. */
export interface PreparedOrder {
  order: string;
  baseUnits: string;
  display: string;
  feeBaseUnits: string;
  listing: QuotedListing;
}

/** Several orders, one transaction, one wallet approval: a cart. */
export interface PreparedCartCheckout {
  ok: true;
  transaction: string;
  orders: PreparedOrder[];
  token: PayToken;
  totalBaseUnits: string;
  totalDisplay: string;
  rate: FxRate | null;
  windowSecs: number;
  /** The transaction's last valid block height: past it, it can never land (payment-status.ts). */
  validUntil: number;
}

export interface CheckoutError {
  ok: false;
  /** HTTP status the route should answer with. */
  status: number;
  error: string;
  /** When the wallet is short of the coin: how much more it needs, in whole coins. */
  shortfall?: number;
  token?: PayToken;
  /** "quote_expired": a price ran out; the form offers to fetch the current one, keeping the address. */
  code?: "quote_expired";
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
  input: { quote: unknown; buyer: unknown; address: unknown; token?: unknown },
  deps: CheckoutDeps = {},
): Promise<PreparedCheckout | CheckoutError> {
  const r = await prepareOrders({ quotes: [input.quote], buyer: input.buyer, address: input.address, token: input.token }, deps);
  if (!r.ok) return r;
  const o = r.orders[0];
  return {
    ok: true,
    transaction: r.transaction,
    order: o.order,
    token: r.token,
    baseUnits: o.baseUnits,
    display: o.display,
    feeBaseUnits: o.feeBaseUnits,
    rate: r.rate,
    windowSecs: r.windowSecs,
    validUntil: r.validUntil,
    listing: o.listing,
  };
}

/** A cart: up to MAX_CART_ORDERS signed quotes, paid with one approval. */
export async function prepareCartCheckout(
  input: { quotes: unknown; buyer: unknown; address: unknown; token?: unknown },
  deps: CheckoutDeps = {},
): Promise<PreparedCartCheckout | CheckoutError> {
  if (!Array.isArray(input.quotes) || input.quotes.length === 0) return { ok: false, status: 400, error: "Nothing to pay for." };
  if (input.quotes.length > MAX_CART_ORDERS) {
    return { ok: false, status: 400, error: `One payment covers up to ${MAX_CART_ORDERS} items. Pay for the rest in a second payment.` };
  }
  return prepareOrders({ quotes: input.quotes, buyer: input.buyer, address: input.address, token: input.token }, deps);
}

/** The coin asked for, or the default for these listings: EURC when all are in euros. */
export function chooseToken(asked: unknown, listings: { currency: string }[]): PayToken {
  return parsePayToken(asked) ?? defaultPayToken(listings.map((l) => l.currency));
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
      return {
        ok: false,
        status: q.reason === "not_configured" ? 503 : 400,
        error: messages[q.reason],
        ...(q.reason === "expired" ? { code: "quote_expired" as const } : {}),
      };
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

type Priced = { listing: QuotedListing; item: bigint; total: bigint; fee: bigint };

/**
 * Step 3, shared by the payment and its invoice: each item in the chosen coin
 * (EURC one to one for euros, otherwise at one ECB rate for the whole
 * payment), plus the service fee signed into its quote. The invoice can't show
 * a number the payment wouldn't charge.
 */
async function priceListings(
  listings: QuotedListing[],
  token: PayToken,
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; rate: FxRate | null; priced: Priced[]; total: bigint } | CheckoutError> {
  const many = listings.length > 1;
  const rate = needsRate(listings.map((l) => l.currency), token) ? await eurUsdRate(env, fetchImpl) : null;
  const priced: Priced[] = [];
  for (const listing of listings) {
    const item = toTokenBaseUnits(listing.amount, listing.currency, token, rate);
    if (item === null) {
      const known = ["EUR", "USD"].includes(listing.currency.toUpperCase());
      return {
        ok: false,
        status: known ? 503 : 400,
        error: known
          ? `No exchange rate is available right now, so ${many ? "these" : "this"} cannot be priced in ${token}.`
          : `Listings priced in ${listing.currency} cannot be paid in ${token} yet.`,
      };
    }
    // SigPath's service fee, at the rate signed into the quote, goes into the
    // escrow with the price: paid out on fulfilment, refunded with it otherwise.
    const { fee, total } = withServiceFee(item, listing.feeBps ?? 0);
    if (total > orders.MAX_AMOUNT) {
      return {
        ok: false,
        status: 400,
        error: `${many ? `"${listing.title}" costs` : "This costs"} ${orders.formatToken(total, token)}, over the ${orders.formatToken(orders.MAX_AMOUNT, token)} per-order limit.`,
      };
    }
    priced.push({ listing, item, total, fee });
  }
  return { ok: true, rate, priced, total: priced.reduce((t, x) => t + x.total, 0n) };
}

/**
 * What a total is worth in euros, in cents: the "= 150,00 €" beside it. EURC
 * is euros already; USDC is converted back at the same rate it was priced at.
 * Null when there is no rate to say it with (a USDC payment of dollar listings).
 */
export function euroValueCents(total: bigint, token: PayToken, rate: FxRate | null): number | null {
  if (token === "EURC") return Number((total + 5_000n) / 10_000n);
  return rate ? usdcInEuroCents(total, rate) : null;
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
  /** In base units of the coin paid in: the item, the service fee, and the two together. */
  itemBase: string;
  feeBase: string;
  totalBase: string;
  feeBps: number;
}

export interface Invoice {
  ok: true;
  /** The coin this invoice is in. */
  token: PayToken;
  lines: InvoiceLine[];
  totalBase: string;
  totalDisplay: string;
  /** The total's worth in euros (cents), for "= 150,00 €" beside it; null without a rate. */
  euroCents: number | null;
  /** Per currency, in minor units: what the items cost before conversion. */
  localTotals: { amount: number; currency: string }[];
  rate: { display: string; source: string } | null;
}

/** The invoice for these quotes in the chosen coin: what's being bought, and every conversion. Charges nothing. */
export async function invoiceFor(quotes: unknown, deps: CheckoutDeps = {}, asked?: unknown): Promise<Invoice | CheckoutError> {
  const env = deps.env ?? process.env;
  if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > MAX_CART_ORDERS) {
    return { ok: false, status: 400, error: "Nothing to show." };
  }
  const v = verifyQuotes(quotes, env, deps);
  if (!v.ok) return v;
  const token = chooseToken(asked, v.listings);
  const p = await priceListings(v.listings, token, env, deps.fetchImpl);
  if (!p.ok) return p;
  const local = new Map<string, number>();
  for (const l of v.listings) local.set(l.currency, (local.get(l.currency) ?? 0) + l.amount);
  return {
    ok: true,
    token,
    lines: p.priced.map((x) => ({
      source: x.listing.source,
      id: x.listing.id,
      title: x.listing.title,
      url: x.listing.url,
      amount: x.listing.amount,
      currency: x.listing.currency,
      itemBase: x.item.toString(),
      feeBase: x.fee.toString(),
      totalBase: x.total.toString(),
      feeBps: x.listing.feeBps ?? 0,
    })),
    totalBase: p.total.toString(),
    totalDisplay: orders.formatToken(p.total, token),
    euroCents: euroValueCents(p.total, token, p.rate),
    localTotals: [...local].map(([currency, amount]) => ({ currency, amount })),
    rate: p.rate ? { display: p.rate.display, source: p.rate.source } : null,
  };
}

async function prepareOrders(
  input: { quotes: unknown[]; buyer: unknown; address: unknown; token?: unknown },
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

  // 3. prices in the chosen coin, at one rate for the whole payment if any is needed
  const token = chooseToken(input.token, listings);
  const p = await priceListings(listings, token, env, deps.fetchImpl);
  if (!p.ok) return p;
  const { rate, priced, total } = p;

  // 4. can this wallet pay for all of it?
  const conn = deps.conn ?? new Connection(ordersRpcUrl(env), "confirmed");
  const mint = orders.mintOf(token);
  const buyerToken = associatedTokenAddress(buyer, mint);
  const { balances, lamports } = await walletFunds(conn, buyer);
  const have = balances[token];
  if (have < total) {
    return {
      ok: false,
      status: 402,
      shortfall: Number(total - have) / 10 ** orders.TOKEN_DECIMALS,
      token,
      error: `This wallet holds ${orders.formatToken(have, token)}; ${many ? "these orders need" : "the order needs"} ${orders.formatToken(total, token)}.`,
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
        amount: p.total,
        listingHash: orders.listingHash(p.listing),
        windowSecs,
        mint,
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
        { address: addr.address, buyer: buyer.toBase58(), listing, token, amount: b.total.toString(), fee: b.fee.toString() },
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
      baseUnits: b.total.toString(),
      display: orders.formatToken(b.total, token),
      feeBaseUnits: b.fee.toString(),
      listing: b.listing,
    })),
    token,
    totalBaseUnits: total.toString(),
    totalDisplay: orders.formatToken(total, token),
    rate,
    windowSecs,
    validUntil: lastValidBlockHeight,
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
    orders.refundIx({ caller, order, buyer: state.buyer, mint: state.mint }),
  );
  return { ok: true, transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
}
