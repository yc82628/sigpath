import Link from "next/link";
import { Connection, PublicKey } from "@solana/web3.js";
import { NotAnOrderError, ordersRpcUrl, readOrder } from "@/lib/checkout/checkout";
import { AddressStore } from "@/lib/checkout/address-store";
import { formatUsdc, ORDERS_PROGRAM_ID } from "@/lib/chains/solana/orders";
import RefundButton from "./RefundButton";
import { REPORT_WINDOW_SECS } from "@/lib/reports/order-meta";

/**
 * app/order/[order]/page.tsx — an order, as the chain sees it.
 *
 * Public by nature: the order address is on chain, so this page shows only
 * what anyone could read there anyway — status, amount, deadline. Not the
 * delivery address, and not the item: the chain holds a hash of what was
 * bought, and printing the title would tell anyone with this link what this
 * person purchased.
 *
 * It does say whether SigPath still holds the delivery address, because the
 * shopper is entitled to see that it was deleted.
 */

export const dynamic = "force-dynamic";

function explorer(address: string) {
  const rpc = ordersRpcUrl();
  const cluster = rpc.includes("devnet")
    ? "?cluster=devnet"
    : rpc.includes("127.0.0.1") || rpc.includes("localhost")
      ? `?cluster=custom&customUrl=${encodeURIComponent(rpc)}`
      : "";
  return `https://explorer.solana.com/address/${address}${cluster}`;
}

function when(unix: number) {
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const STATUS_TEXT = {
  funded: "Paid — awaiting fulfilment",
  fulfilled: "Fulfilled",
  refunded: "Refunded",
} as const;

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: { order: string };
  searchParams: { pending?: string };
}) {
  let order: PublicKey;
  try {
    order = new PublicKey(params.order);
  } catch {
    return (
      <main className="container">
        <h1>Order</h1>
        <p className="notice withheld">That isn&apos;t a valid order address.</p>
      </main>
    );
  }

  let state;
  try {
    state = await readOrder(new Connection(ordersRpcUrl(), "confirmed"), order);
  } catch (err) {
    return (
      <main className="container">
        <h1>Order</h1>
        <p className="notice withheld">
          {err instanceof NotAnOrderError
            ? "That address exists, but it isn't a SigPath order."
            : `Couldn't read the order from the network (${err instanceof Error ? err.message : "unknown error"}).`}
        </p>
      </main>
    );
  }

  if (!state.found) {
    return (
      <main className="container">
        <h1>Order</h1>
        <p className="notice withheld">
          {searchParams.pending
            ? "Your payment was sent but isn't visible yet. Reload in a moment."
            : "No order exists at this address."}
        </p>
      </main>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const store = AddressStore.fromEnv();
  const addressHeld = store ? (await store.list()).some((r) => r.order === order.toBase58()) : false;
  const refundOpen = state.status === "funded" && now > state.deadline;

  return (
    <main className="container">
      <h1>Order</h1>
      <p className={`order-status ${state.status}`}>{STATUS_TEXT[state.status]}</p>

      <dl className="order-facts">
        <dt>Amount in escrow</dt>
        <dd>{formatUsdc(state.amount)}</dd>
        <dt>Placed</dt>
        <dd>{when(state.createdAt)}</dd>
        <dt>Fulfilment deadline</dt>
        <dd>{when(state.deadline)}</dd>
        {state.settledAt > 0 && (
          <>
            <dt>Settled</dt>
            <dd>{when(state.settledAt)}</dd>
          </>
        )}
        <dt>Delivery address</dt>
        <dd>
          {addressHeld
            ? "Held encrypted until this order settles"
            : state.status === "funded"
              ? "Not held on this server"
              : "Deleted"}
        </dd>
      </dl>

      {state.status === "funded" &&
        (refundOpen ? (
          <>
            <p className="notice">
              The deadline has passed without fulfilment. The refund is open, and it can only go
              back to the wallet that paid.
            </p>
            <RefundButton order={order.toBase58()} />
          </>
        ) : (
          <p className="hint">
            If SigPath hasn&apos;t fulfilled this by the deadline, a refund button appears here —
            and the program guarantees it.
          </p>
        ))}

      {state.status === "fulfilled" && (
        <>
          <p className="hint">
            SigPath committed a hash of the retailer&apos;s order reference on chain when it fulfilled
            this. If what arrives doesn&apos;t match, that reference is your evidence.
          </p>
          {now <= state.settledAt + REPORT_WINDOW_SECS && (
            <p>
              <Link className="pay" href={`/report/${order.toBase58()}`}>
                Received a fake? Report it &rarr;
              </Link>
            </p>
          )}
        </>
      )}

      <p className="hint">
        <a href={explorer(order.toBase58())} target="_blank" rel="noopener noreferrer">
          View this order on Solana Explorer
        </a>{" "}
        &middot; program{" "}
        <a href={explorer(ORDERS_PROGRAM_ID.toBase58())} target="_blank" rel="noopener noreferrer">
          {ORDERS_PROGRAM_ID.toBase58().slice(0, 8)}…
        </a>{" "}
        &middot; <Link href="/search">Search</Link>
      </p>
    </main>
  );
}
