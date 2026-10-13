"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { checkoutCandidates, quoteFresh, removeItem, setQuote, type CartItem } from "@/lib/cart/cart";
import { readCart, writeCart } from "../../components/cart-store";
import { useCheckText, useLang, useMessages } from "../../components/I18n";
import CheckoutForm from "../CheckoutForm";
import Invoice, { usdc, type InvoiceData } from "../Invoice";

type Ready = { item: CartItem; token: string; usdc?: string };
type NotReady = { item: CartItem; reason: string };

export default function CartCheckout({ max, moonPay }: { max: number; moonPay: boolean }) {
  const m = useMessages();
  const lang = useLang();
  const tc = useCheckText();
  const [state, setState] = useState<{ ready: Ready[]; notReady: NotReady[]; later: number } | null>(null);
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [paid, setPaid] = useState<{ orders: Record<string, string>; list: { order: string; title: string }[]; confirmed: boolean; wallet?: string; at: number } | null>(null);
  const started = useRef(false);

  // Gather the cart's SigPath-checked items; check again any whose quote ran out.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const all = checkoutCandidates(readCart());
      const batch = all.slice(0, max);
      const stale = batch.filter((c) => !quoteFresh(c));
      let fresh: Record<string, { ok: boolean; token?: string; usdc?: string; expiresAt?: number; reason?: string }> = {};
      if (stale.length) {
        try {
          const res = await fetch("/api/cart/requote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ items: stale.map((c) => ({ source: c.source, id: c.id, title: c.title })) }),
          });
          const body = await res.json().catch(() => ({}));
          if (res.ok) fresh = Object.fromEntries((body.quotes ?? []).map((q: { key: string }) => [q.key, q]));
          else for (const c of stale) fresh[c.key] = { ok: false, reason: body.error ?? m.cart.checkFailed };
        } catch {
          for (const c of stale) fresh[c.key] = { ok: false, reason: m.cart.checkFailed };
        }
      }
      let cart = readCart();
      const ready: Ready[] = [];
      const notReady: NotReady[] = [];
      for (const c of batch) {
        if (quoteFresh(c)) {
          ready.push({ item: c, token: c.quote!.token, usdc: c.quote!.usdc });
          continue;
        }
        const q = fresh[c.key];
        if (q?.ok && q.token && q.expiresAt) {
          cart = setQuote(cart, c.key, { token: q.token, usdc: q.usdc, expiresAt: q.expiresAt });
          ready.push({ item: c, token: q.token, usdc: q.usdc });
        } else {
          notReady.push({ item: c, reason: q?.reason ?? m.cart.checkFailed });
        }
      }
      writeCart(cart);
      setState({ ready, notReady, later: Math.max(0, all.length - batch.length) });

      // The invoice: every price and conversion, from the same code as the payment.
      if (ready.length) {
        try {
          const res = await fetch("/api/checkout/invoice", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ quotes: ready.map((r) => r.token) }),
          });
          const body = await res.json().catch(() => ({}));
          if (res.ok) setInvoice(body);
          else setInvoiceError(body.error ?? m.cart.checkFailed);
        } catch {
          setInvoiceError(m.cart.checkFailed);
        }
      }
    })();
  }, [max, m]);

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
          moonPay={moonPay}
          onPaid={(orders, confirmed, wallet) => {
            // Paid items leave the cart; their order pages, and this invoice, are the record now.
            let cart = readCart();
            for (const o of orders) cart = removeItem(cart, `${o.source}:${o.id}`);
            writeCart(cart);
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
