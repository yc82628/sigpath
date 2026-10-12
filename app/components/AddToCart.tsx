"use client";

import Link from "next/link";
import { useState } from "react";
import { addItem, CART_MAX_ITEMS, type CartItem } from "@/lib/cart/cart";
import { readCart, useCart, writeCart } from "./cart-store";
import { useMessages } from "./I18n";

/**
 * "Add to cart" on a search result. The item is a snapshot of the listing as
 * the search showed it (lib/cart/cart.ts); the icon comes from the server as
 * children, so the icon shapes stay out of the browser's JavaScript.
 */
export default function AddToCart({ item, children }: { item: Omit<CartItem, "addedAt">; children?: React.ReactNode }) {
  const cart = useCart();
  const m = useMessages();
  const [error, setError] = useState<string | null>(null);
  const inCart = !!cart?.some((c) => c.key === item.key);

  if (inCart) {
    return (
      <p className="cart-added">
        {m.listing.inCart} <Link href="/cart">{m.listing.viewCart}</Link>
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
          if (!r.ok) return setError(m.listing.cartFull(CART_MAX_ITEMS));
          if (!writeCart(r.cart)) setError(m.listing.storageBlocked);
        }}
      >
        {children}
        {m.listing.addToCart}
      </button>
      {error && <p className="pay-blocked">{error}</p>}
    </>
  );
}
