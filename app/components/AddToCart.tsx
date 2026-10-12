"use client";

import Link from "next/link";
import { useState } from "react";
import { addItem, type CartItem } from "@/lib/cart/cart";
import { readCart, useCart, writeCart } from "./cart-store";

/**
 * "Add to cart" on a search result. The item is a snapshot of the listing as
 * the search showed it (lib/cart/cart.ts); the icon comes from the server as
 * children, so the icon shapes stay out of the browser's JavaScript.
 */
export default function AddToCart({ item, children }: { item: Omit<CartItem, "addedAt">; children?: React.ReactNode }) {
  const cart = useCart();
  const [error, setError] = useState<string | null>(null);
  const inCart = !!cart?.some((c) => c.key === item.key);

  if (inCart) {
    return (
      <p className="cart-added">
        In your cart. <Link href="/cart">View cart &rarr;</Link>
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className="add-to-cart"
        disabled={cart === null}
        onClick={() => {
          const r = addItem(readCart(), { ...item, addedAt: Date.now() });
          if (!r.ok) return setError(r.reason);
          if (!writeCart(r.cart)) setError("This browser won't let SigPath keep a cart (storage is blocked).");
        }}
      >
        {children}
        Add to cart
      </button>
      {error && <p className="pay-blocked">{error}</p>}
    </>
  );
}
