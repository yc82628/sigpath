"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { canPayNow, itemTotal, priceMoved, removeItem, totals, type CartItem, type Freshness } from "@/lib/cart/cart";
import { formatMoney } from "@/lib/marketplace/types";
import { readCart, useCart, writeCart } from "../components/cart-store";

const MARKET: Record<string, string> = { ebay: "eBay", amazon: "Amazon", aliexpress: "AliExpress", stub: "Demo", feed: "Partner feed" };
const VERDICT: Record<CartItem["verdict"], string> = {
  checked: "✓ SigPath-checked when you added it",
  caution: "! Look closer: flagged when you added it",
  unchecked: "Not price-checked when you added it",
};

const shipLabel = (s?: { amount: number }) => (!s ? "shipping not included" : s.amount > 0 ? "incl. shipping" : "free shipping");

export default function CartView({ removeIcon }: { removeIcon?: React.ReactNode }) {
  const cart = useCart();
  const [fresh, setFresh] = useState<Record<string, Freshness>>({});
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const keys = useMemo(() => (cart ?? []).map((c) => c.key).join(","), [cart]);

  // Ask for the prices now whenever the set of items changes (and on opening).
  useEffect(() => {
    if (!cart?.length) return;
    const missing = cart.filter((c) => !fresh[c.key]);
    if (!missing.length) return;
    let live = true;
    setChecking(true);
    setCheckError(null);
    fetch("/api/cart/prices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: missing.map((c) => ({ source: c.source, id: c.id })) }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) return setCheckError(body.error ?? "The prices couldn't be checked just now.");
        setFresh((f) => ({ ...f, ...(body.prices ?? {}) }));
      })
      .catch(() => live && setCheckError("The prices couldn't be checked just now."))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  if (cart === null) return <p className="hint">Opening your cart&hellip;</p>;
  if (!cart.length) {
    return (
      <section className="cart-empty">
        <p>Your cart is empty.</p>
        <p>
          <Link className="button" href="/search">
            Find a deal
          </Link>
        </p>
      </section>
    );
  }

  const sums = totals(cart, fresh);
  return (
    <>
      {checking && <p className="hint">Checking today&apos;s prices&hellip;</p>}
      {checkError && <p className="notice withheld">{checkError}</p>}
      <ul className="cart-list">
        {cart.map((c) => {
          const f = fresh[c.key];
          const was = itemTotal(c.price, c.shipping);
          const now = f && (f.status === "ok" || f.status === "sold_out") ? itemTotal(f.price, f.shipping) : null;
          const moved = priceMoved(c, f);
          return (
            <li key={c.key} className={`listing cart-item${f?.status === "gone" || f?.status === "sold_out" ? " gone" : ""}`}>
              <div className="thumb" aria-hidden="true">
                {c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  (MARKET[c.source] ?? c.source).slice(0, 1)
                )}
              </div>
              <div className="body">
                <h3>
                  <a href={c.url} target="_blank" rel="noopener noreferrer">
                    {c.title}
                  </a>
                </h3>
                <p className="meta">
                  <span className="chip">{MARKET[c.source] ?? c.source}</span> {c.condition} &middot; {c.seller}
                </p>
                <p className={`cart-verdict ${c.verdict}`}>{VERDICT[c.verdict]}</p>
                {f?.status === "gone" && <p className="notice withheld">This listing has ended on {MARKET[c.source] ?? c.source}.</p>}
                {f?.status === "sold_out" && <p className="notice withheld">Sold out right now.</p>}
                {moved && now && (
                  <p className="notice withheld">
                    The price changed: {formatMoney(was)} when you added it, {formatMoney(now)} now. Check it again before you buy.
                  </p>
                )}
                {f?.status === "unchecked" && <p className="hint">{f.reason}</p>}
                <div className="cart-actions">
                  {canPayNow(c, f) && c.quote ? (
                    <a className="pay" href={`/checkout?quote=${encodeURIComponent(c.quote.token)}`}>
                      Pay with USDC{c.quote.usdc && <span className="pay-amount"> · {c.quote.usdc}</span>} &rarr;
                    </a>
                  ) : (
                    c.verdict === "checked" &&
                    f?.status !== "gone" && (
                      <Link className="button ghost" href={`/search?q=${encodeURIComponent(c.title.slice(0, 120))}#l-${encodeURIComponent(c.key)}`}>
                        Check it again
                      </Link>
                    )
                  )}
                  {f?.status !== "gone" && c.source !== "stub" && (
                    <a className="button ghost" href={c.url} target="_blank" rel="noopener noreferrer">
                      Buy on {MARKET[c.source] ?? c.source} &rarr;
                    </a>
                  )}
                  <button type="button" className="cart-remove" onClick={() => writeCart(removeItem(readCart(), c.key))}>
                    {removeIcon}
                    Remove
                  </button>
                </div>
              </div>
              <div className="price">
                {formatMoney(now ?? was)}
                <span className="ship">{shipLabel(f && "price" in f ? f.shipping : c.shipping)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <section className="cart-summary" aria-label="Cart total">
        <p>
          <strong>
            {cart.length} item{cart.length === 1 ? "" : "s"}:
          </strong>{" "}
          {sums.length ? sums.map(formatMoney).join(" + ") : "nothing still for sale"}
        </p>
        <p className="hint">Each item is paid for separately, as each seller ships on their own.</p>
        <button type="button" className="button ghost" onClick={() => writeCart([])}>
          Empty the cart
        </button>
      </section>
    </>
  );
}
