import Link from "next/link";
import { Connection, PublicKey } from "@solana/web3.js";
import { NotAnOrderError, ordersRpcUrl, readOrder } from "@/lib/checkout/checkout";
import { AddressStore } from "@/lib/checkout/address-store";
import { formatUsdc, ORDERS_PROGRAM_ID } from "@/lib/chains/solana/orders";
import RefundButton from "./RefundButton";
import { REPORT_WINDOW_SECS } from "@/lib/reports/order-meta";
import { getLang } from "@/lib/i18n/server";
import { decimalText } from "@/lib/i18n/money";

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

/** The page's words, in English and German. */
const en = {
  order: "Order",
  status: { funded: "Paid — awaiting fulfilment", fulfilled: "Fulfilled", refunded: "Refunded" },
  invalid: "That isn't a valid order address.",
  notOrder: "That address exists, but it isn't a SigPath order.",
  unreadable: (why: string) => `Couldn't read the order from the network (${why}).`,
  unknownError: "unknown error",
  pending: "Your payment was sent but isn't visible yet. Reload in a moment.",
  none: "No order exists at this address.",
  amount: "Amount in escrow",
  placed: "Placed",
  deadline: "Fulfilment deadline",
  settled: "Settled",
  address: "Delivery address",
  held: "Held encrypted until this order settles",
  notHeld: "Not held on this server",
  deleted: "Deleted",
  refundOpen: "The deadline has passed without fulfilment. The refund is open, and it can only go back to the wallet that paid.",
  refundLater: "If SigPath hasn't fulfilled this by the deadline, a refund button appears here — and the program guarantees it.",
  evidence: "SigPath committed a hash of the retailer's order reference on chain when it fulfilled this. If what arrives doesn't match, that reference is your evidence.",
  report: "Received a fake? Report it →",
  explorer: "View this order on Solana Explorer",
  program: "program",
  search: "Search",
};
const de: typeof en = {
  order: "Bestellung",
  status: { funded: "Bezahlt, wartet auf Erfüllung", fulfilled: "Erfüllt", refunded: "Erstattet" },
  invalid: "Das ist keine gültige Bestelladresse.",
  notOrder: "Diese Adresse gibt es, aber sie ist keine SigPath-Bestellung.",
  unreadable: (why) => `Die Bestellung konnte nicht aus dem Netzwerk gelesen werden (${why}).`,
  unknownError: "unbekannter Fehler",
  pending: "Deine Zahlung wurde gesendet, ist aber noch nicht sichtbar. Lade die Seite gleich neu.",
  none: "Unter dieser Adresse gibt es keine Bestellung.",
  amount: "Betrag in der Treuhand",
  placed: "Aufgegeben",
  deadline: "Frist für die Erfüllung",
  settled: "Abgeschlossen",
  address: "Lieferadresse",
  held: "Verschlüsselt gespeichert, bis die Bestellung abgeschlossen ist",
  notHeld: "Nicht auf diesem Server gespeichert",
  deleted: "Gelöscht",
  refundOpen: "Die Frist ist ohne Erfüllung abgelaufen. Die Rückerstattung ist offen, und das Geld kann nur an die Wallet zurückgehen, die bezahlt hat.",
  refundLater: "Erfüllt SigPath die Bestellung nicht bis zur Frist, erscheint hier ein Button zur Rückerstattung, und das Programm garantiert sie.",
  evidence: "SigPath hat bei der Erfüllung einen Hashwert der Bestellnummer des Händlers auf der Blockchain hinterlegt. Passt die Lieferung nicht, ist diese Nummer dein Beweis.",
  report: "Eine Fälschung erhalten? Melde sie →",
  explorer: "Diese Bestellung im Solana Explorer ansehen",
  program: "Programm",
  search: "Suche",
};

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: { order: string };
  searchParams: { pending?: string };
}) {
  const t = getLang() === "de" ? de : en;
  let order: PublicKey;
  try {
    order = new PublicKey(params.order);
  } catch {
    return (
      <main className="container">
        <h1>{t.order}</h1>
        <p className="notice withheld">{t.invalid}</p>
      </main>
    );
  }

  let state;
  try {
    state = await readOrder(new Connection(ordersRpcUrl(), "confirmed"), order);
  } catch (err) {
    return (
      <main className="container">
        <h1>{t.order}</h1>
        <p className="notice withheld">
          {err instanceof NotAnOrderError
            ? t.notOrder
            : t.unreadable(err instanceof Error ? err.message : t.unknownError)}
        </p>
      </main>
    );
  }

  if (!state.found) {
    return (
      <main className="container">
        <h1>{t.order}</h1>
        <p className="notice withheld">
          {searchParams.pending
            ? t.pending
            : t.none}
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
      <h1>{t.order}</h1>
      <p className={`order-status ${state.status}`}>{t.status[state.status]}</p>

      <dl className="order-facts">
        <dt>{t.amount}</dt>
        <dd>{decimalText(formatUsdc(state.amount), getLang())}</dd>
        <dt>{t.placed}</dt>
        <dd>{when(state.createdAt)}</dd>
        <dt>{t.deadline}</dt>
        <dd>{when(state.deadline)}</dd>
        {state.settledAt > 0 && (
          <>
            <dt>{t.settled}</dt>
            <dd>{when(state.settledAt)}</dd>
          </>
        )}
        <dt>{t.address}</dt>
        <dd>
          {addressHeld
            ? t.held
            : state.status === "funded"
              ? t.notHeld
              : t.deleted}
        </dd>
      </dl>

      {state.status === "funded" &&
        (refundOpen ? (
          <>
            <p className="notice">
              {t.refundOpen}
            </p>
            <RefundButton order={order.toBase58()} />
          </>
        ) : (
          <p className="hint">
            {t.refundLater}
          </p>
        ))}

      {state.status === "fulfilled" && (
        <>
          <p className="hint">
            {t.evidence}
          </p>
          {now <= state.settledAt + REPORT_WINDOW_SECS && (
            <p>
              <Link className="pay" href={`/report/${order.toBase58()}`}>
                {t.report}
              </Link>
            </p>
          )}
        </>
      )}

      <p className="hint">
        <a href={explorer(order.toBase58())} target="_blank" rel="noopener noreferrer">
          {t.explorer}
        </a>{" "}
        &middot; {t.program}{" "}
        <a href={explorer(ORDERS_PROGRAM_ID.toBase58())} target="_blank" rel="noopener noreferrer">
          {ORDERS_PROGRAM_ID.toBase58().slice(0, 8)}…
        </a>{" "}
        &middot; <Link href="/search">{t.search}</Link>
      </p>
    </main>
  );
}
