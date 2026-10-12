"use client";

import Link from "next/link";
import { useCart } from "./cart-store";
import { useMessages } from "./I18n";

/** The header's cart icon, with how many items are in it. The icon arrives from the server as children. */
export default function CartLink({ children }: { children: React.ReactNode }) {
  const cart = useCart();
  const m = useMessages();
  const n = cart?.length ?? 0;
  const label = n ? m.nav.cartItems(n) : m.nav.cart;
  return (
    <Link href="/cart" className="nav-icon" aria-label={label} data-label={label}>
      {children}
      {n > 0 && (
        <span className="cart-count" aria-hidden="true">
          {n > 9 ? "9+" : n}
        </span>
      )}
    </Link>
  );
}
