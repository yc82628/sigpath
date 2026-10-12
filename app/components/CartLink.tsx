"use client";

import Link from "next/link";
import { useCart } from "./cart-store";

/** The header's cart icon, with how many items are in it. The icon arrives from the server as children. */
export default function CartLink({ children }: { children: React.ReactNode }) {
  const cart = useCart();
  const n = cart?.length ?? 0;
  const label = n ? `Cart, ${n} item${n === 1 ? "" : "s"}` : "Cart";
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
