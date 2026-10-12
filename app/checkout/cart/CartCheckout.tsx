"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { checkoutCandidates, quoteFresh, removeItem, setQuote, type CartItem } from "@/lib/cart/cart";
import { formatMoney } from "@/lib/marketplace/types";
import { readCart, writeCart } from "../../components/cart-store";
import CheckoutForm from "../CheckoutForm";

type Ready = { item: CartItem; token: string; usdc?: string };
type NotReady = { item: CartItem; reason: string };

/** "87.82 USDC" -> 87.82. The previews are rounded up, so their sum is never below what's charged. */
const usdcValue = (s?: string) => (s ? Number(s.replace(/[^0-9.]/g, "")) : NaN);

export default function CartCheckout({ max, moonPay }: { max: number; moonPay: boolean }) {
  const [state, setState] = useState<{ ready: Ready[]; notReady: NotReady[]; later: number } | null>(null);
  const [paid, setPaid] = useState<{ orders: { order: string; title: string }[]; confirmed: boolean } | null>(null);
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
          else for (const c of stale) fresh[c.key] = { ok: false, reason: body.error ?? "The prices couldn't be checked again just now." };
        } catch {
          for (const c of stale) fresh[c.key] = { ok: false, reason: "The prices couldn't be checked again just now." };
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
          notReady.push({ item: c, reason: q?.reason ?? "It couldn't be checked again." });
        }
      }
      writeCart(cart);
      setState({ ready, notReady, later: Math.max(0, all.length - batch.length) });
    })();
  }, [max]);

  if (paid) {
    return (
      <section className="notice">
        <p>
          <strong>{paid.confirmed ? "Paid." : "Payment sent; the network is still confirming."}</strong> One order per item:
        </p>
        <ul>
          {paid.orders.map((o) => (
            <li key={o.order}>
              <Link href={`/order/${o.order}${paid.confirmed ? "" : "?pending=1"}`}>{o.title}</Link>
            </li>
          ))}
        </ul>
        <p>
          <Link href="/cart">Back to your cart</Link>
        </p>
      </section>
    );
  }
  if (!state) return <p className="hint">Checking your items&hellip;</p>;
  if (!state.ready.length) {
    return (
      <>
        {state.notReady.length ? <NotReadyList items={state.notReady} /> : <p className="notice withheld">There are no SigPath-checked items in your cart to pay for here.</p>}
        <p>
          <Link href="/cart">Back to your cart</Link> to buy them on eBay instead.
        </p>
      </>
    );
  }

  const sum = state.ready.reduce((t, r) => t + usdcValue(r.usdc), 0);
  const display = Number.isFinite(sum) ? `${sum.toFixed(2)} USDC` : "the total";
  return (
    <>
      <ul className="cart-list">
        {state.ready.map((r) => (
          <li key={r.item.key} className="listing cart-item">
            <div className="body">
              <h3>{r.item.title}</h3>
              <p className="meta">
                {r.item.condition} &middot; {r.item.seller}
              </p>
            </div>
            <div className="price">
              {r.usdc ?? formatMoney(r.item.price)}
              <span className="ship">incl. shipping and fee</span>
            </div>
          </li>
        ))}
      </ul>
      {state.notReady.length > 0 && <NotReadyList items={state.notReady} />}
      {state.later > 0 && (
        <p className="hint">
          {state.later} more checked item{state.later === 1 ? "" : "s"} can be paid in a second payment (up to {max} at a time).
        </p>
      )}
      <CheckoutForm
        quotes={state.ready.map((r) => r.token)}
        usdcDisplay={display}
        moonPay={moonPay}
        onPaid={(orders, confirmed) => {
          // Paid items leave the cart; their order pages are the record now.
          let cart = readCart();
          for (const o of orders) cart = removeItem(cart, `${o.source}:${o.id}`);
          writeCart(cart);
          const title = (o: { source: string; id: string }) => state.ready.find((r) => r.item.key === `${o.source}:${o.id}`)?.item.title ?? "Order";
          setPaid({ orders: orders.map((o) => ({ order: o.order, title: title(o) })), confirmed });
        }}
      />
    </>
  );
}

function NotReadyList({ items }: { items: NotReady[] }) {
  return (
    <section className="notice withheld">
      <p>
        <strong>Not included</strong> (buy {items.length === 1 ? "it" : "these"} on eBay from your cart):
      </p>
      <ul>
        {items.map((n) => (
          <li key={n.item.key}>
            {n.item.title}: {n.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}
