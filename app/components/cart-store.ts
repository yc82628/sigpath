"use client";

/**
 * The cart in this browser's localStorage (see lib/cart/cart.ts for why).
 * Every read and write is wrapped: storage can be blocked or full (private
 * windows, strict settings), and then the cart is simply empty rather than
 * an error. Other tabs hear about changes through the "storage" event, this
 * tab through a custom one.
 */

import { useEffect, useState } from "react";
import { CART_STORAGE_KEY, parseCart, prune, type CartItem } from "@/lib/cart/cart";

const EVENT = "sigpath-cart";

export function readCart(): CartItem[] {
  try {
    return prune(parseCart(localStorage.getItem(CART_STORAGE_KEY)));
  } catch {
    return [];
  }
}

export function writeCart(cart: CartItem[]): boolean {
  try {
    if (cart.length) localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    else localStorage.removeItem(CART_STORAGE_KEY);
    window.dispatchEvent(new Event(EVENT));
    return true;
  } catch {
    return false;
  }
}

/** The cart, kept current; null until it has been read (so nothing flashes "empty" first). */
export function useCart(): CartItem[] | null {
  const [cart, setCart] = useState<CartItem[] | null>(null);
  useEffect(() => {
    const update = () => setCart(readCart());
    update();
    const onStorage = (e: StorageEvent) => (e.key === CART_STORAGE_KEY || e.key === null) && update();
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return cart;
}
