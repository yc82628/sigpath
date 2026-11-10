"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { checkoutCandidates, quoteFresh, removeItem, setQuote, type CartItem } from "@/lib/cart/cart";
import { readQuote } from "@/lib/checkout/quote-public";
import { readCart, writeCart } from "../../components/cart-store";
import { useCheckText, useLang, useMessages } from "../../components/I18n";
import CheckoutForm from "../CheckoutForm";
import Invoice, { type InvoiceData } from "../Invoice";
import { usdc } from "@/lib/i18n/money";

/**
 * The cart's checkout: its SigPath-checked items, fresh prices, the invoice,
 * one payment.
 *
 * THE CART TRAVELS IN THE LINK
 * The cart lives in this browser's storage. On a phone the wallet step opens
 * SigPath inside the wallet app's own browser (WalletProvider, "Open in
 * Phantom"), which has its own storage and so an empty cart. So once the items
 * are priced, their signed prices go into this page's address (?q=…), and a
 * browser with no cart rebuilds the payment from them. The prices name only
 * the listings, nothing about the shopper, and the server checks every one.
 */

type Ready = { item: CartItem; token: string; usdc?: string };
type NotReady = { item: CartItem; reason: string };
type Fresh = Record<string, { ok: boolean; token?: string; usdc?: string; expiresAt?: number; reason?: string }>;

/** A cart item rebuilt from a signed price in the link: enough to pay for it and name it. */
function itemFromToken(token: string): CartItem | null {
  const q = readQuote(token);
  if (!q) return null;
  return {
    key: `${q.source}:${q.id}`,
    source: q.source,
    id: q.id,
    title: q.title,
    url: "",
    condition: "new",
    seller: "",
    price: { amount: 0, currency: "EUR" },
    verdict: "checked",
    headline: "",
    quote: { token, expiresAt: q.expiresAt * 1000 },
    addedAt: Date.now(),
  };
}

export default function CartCheckout({ max, moonPay }: { max: number; moonPay: boolean }) {
  const m = useMessages();
  const lang = useLang();
  const tc = useCheckText();
  const [state, setState] = useState<{ ready: Ready[]; notReady: NotReady[]; later: number } | null>(null);
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [paid, setPaid] = useState<{ orders: Record<string, string>; list: { order: string; title: string }[]; confirmed: boolean; wallet?: string; at: number } | null>(null);
  const started = useRef(false);
  /** Whether the items came from the link rather than this browser's cart (then the cart isn't written). */
  const linked = useRef(false);

  /** Fresh quotes for these items, by key. A failed request marks each item with why. */
  const requote = useCallback(
    async (items: CartItem[]): Promise<Fresh> => {
      if (!items.length) return {};
      try {
        const res = await fetch("/api/cart/requote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: items.map((c) => ({ source: c.source, id: c.id, title: c.title })) }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) return Object.fromEntries((body.quotes ?? []).map((q: { key: string }) => [q.key, q]));
        return Object.fromEntries(items.map((c) => [c.key, { ok: false, reason: body.error ?? m.cart.checkFailed }]));
      } catch {
        return Object.fromEntries(items.map((c) => [c.key, { ok: false, reason: m.cart.checkFailed }]));
      }
    },
    [m],
  );

  /** The invoice for these prices; resolves to a reason when it couldn't be made. */
  const loadInvoice = useCallback(
    async (tokens: string[]): Promise<string | null> => {
      try {
        const res = await fetch("/api/checkout/invoice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ quotes: tokens }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return body.error ?? m.cart.checkFailed;
        setInvoice(body);
        setInvoiceError(null);
        return null;
      } catch {
        return m.cart.checkFailed;
      }
    },
    [m],
  );

  /** Sort the batch into what can be paid now (fresh quotes, asking again where needed) and what can't. */
  const settle = useCallback(
    async (batch: CartItem[], force: boolean, later: number) => {
      const fresh = await requote(batch.filter((c) => force || !quoteFresh(c)));
      let cart = linked.current ? [] : readCart();
      const ready: Ready[] = [];
      const notReady: NotReady[] = [];
      for (const c of batch) {
        const q = fresh[c.key];
        if (!q && quoteFresh(c)) {
          ready.push({ item: c, token: c.quote!.token, usdc: c.quote!.usdc });
        } else if (q?.ok && q.token && q.expiresAt) {
          if (!linked.current) cart = setQuote(cart, c.key, { token: q.token, usdc: q.usdc, expiresAt: q.expiresAt });
          ready.push({ item: { ...c, quote: { token: q.token, usdc: q.usdc, expiresAt: q.expiresAt } }, token: q.token, usdc: q.usdc });
        } else {
          notReady.push({ item: c, reason: q?.reason ?? m.cart.checkFailed });
        }
      }
      if (!linked.current) writeCart(cart);
      setState({ ready, notReady, later });
      // The priced items in the address, for a wallet app's browser (see above).
      if (ready.length) {
        window.history.replaceState(window.history.state, "", `${window.location.pathname}?q=${ready.map((r) => r.token).join(",")}`);
      }
      return ready;
    },
    [requote, m],
  );

  // Gather the cart's SigPath-checked items, or the ones in the link; check again any whose quote ran out.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      let all = checkoutCandidates(readCart());
      if (!all.length) {
        const tokens = (new URLSearchParams(window.location.search).get("q") ?? "").split(",").filter(Boolean).slice(0, max);
        const fromLink = tokens.map(itemFromToken).filter((c): c is CartItem => c !== null);
        if (fromLink.length) {
          linked.current = true;
          all = fromLink;
        }
      }
      const batch = all.slice(0, max);
      const ready = await settle(batch, false, Math.max(0, all.length - batch.length));
      // The invoice: every price and conversion, from the same code as the payment.
      if (ready.length) {
        const why = await loadInvoice(ready.map((r) => r.token));
        if (why) setInvoiceError(why);
      }
    })();
  }, [max, settle, loadInvoice]);

  /** "Get the current price": every item asked again, the invoice redrawn; the form, and the address in it, stay. */
  const refresh = useCallback(async (): Promise<string | null> => {
    if (!state) return null;
    const ready = await settle(state.ready.map((r) => r.item), true, state.later);
    if (!ready.length) return m.checkout.none;
    return loadInvoice(ready.map((r) => r.token));
  }, [state, settle, loadInvoice, m]);

  if (paid) {
    return (
      <>
        <section className="notice">
          <p>
            <strong>{paid.confirmed ? m.checkout.paid : m.checkout.pending}</strong> {m.checkout.onePerItem}
          </p>
          <ul>
            {paid.list.map((o) => (
              <li key={o.order}>
                <Link href={`/order/${o.order}${paid.confirmed ? "" : "?pending=1"}`}>{o.title}</Link>
              </li>
            ))}
          </ul>
          <p>
            <Link href="/cart">{m.checkout.backToCart}</Link>
          </p>
        </section>
        {invoice && <Invoice data={invoice} paid={{ orders: paid.orders, wallet: paid.wallet, at: paid.at }} />}
      </>
    );
  }
  if (!state) return <p className="hint">{m.checkout.preparing}</p>;
  if (!state.ready.length) {
    return (
      <>
        {state.notReady.length ? <NotReadyList items={state.notReady} /> : <p className="notice withheld">{m.checkout.none}</p>}
        <p>
          <Link href="/cart">{m.checkout.backToCart}</Link> {m.checkout.buyInstead}
        </p>
      </>
    );
  }

  return (
    <>
      {invoice ? <Invoice data={invoice} /> : invoiceError ? <p className="notice withheld">{tc(invoiceError)}</p> : <p className="hint">{m.invoice.loading}</p>}
      {state.notReady.length > 0 && <NotReadyList items={state.notReady} />}
      {state.later > 0 && <p className="hint">{m.checkout.later(state.later, max)}</p>}
      {invoice && (
        <CheckoutForm
          quotes={state.ready.map((r) => r.token)}
          usdcDisplay={usdc(invoice.totalUsdc, lang)}
          totalUsdc={invoice.totalUsdc}
          moonPay={moonPay}
          onRefresh={refresh}
          onPaid={(orders, confirmed, wallet) => {
            // Paid items leave the cart; their order pages, and this invoice, are the record now.
            if (!linked.current) {
              let cart = readCart();
              for (const o of orders) cart = removeItem(cart, `${o.source}:${o.id}`);
              writeCart(cart);
            }
            // The paid prices leave the address too: the link is no way back into a payment.
            window.history.replaceState(window.history.state, "", window.location.pathname);
            const title = (o: { source: string; id: string }) => state.ready.find((r) => r.item.key === `${o.source}:${o.id}`)?.item.title ?? m.invoice.order;
            setPaid({
              orders: Object.fromEntries(orders.map((o) => [`${o.source}:${o.id}`, o.order])),
              list: orders.map((o) => ({ order: o.order, title: title(o) })),
              confirmed,
              wallet,
              at: Date.now(),
            });
          }}
        />
      )}
    </>
  );

  function NotReadyList({ items }: { items: NotReady[] }) {
    return (
      <section className="notice withheld">
        <p>
          <strong>{m.checkout.notIncluded(items.length)}</strong>
        </p>
        <ul>
          {items.map((n) => (
            <li key={n.item.key}>
              {n.item.title}: {tc(n.reason)}
            </li>
          ))}
        </ul>
      </section>
    );
  }
}
