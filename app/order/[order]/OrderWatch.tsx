"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * While a payment is still confirming: asks for the order every few seconds
 * and redraws the page the moment it exists, so nobody has to keep reloading.
 * Gives up quietly after five minutes; the page still says to reload.
 */
export default function OrderWatch({ order }: { order: string }) {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    const until = Date.now() + 5 * 60_000;
    const tick = async () => {
      if (stopped || Date.now() > until) return;
      try {
        const res = await fetch(`/api/orders/${order}`, { cache: "no-store" });
        const body = await res.json();
        if (body.found === true) return router.refresh();
      } catch {
        /* ask again */
      }
      setTimeout(tick, 3000);
    };
    const first = setTimeout(tick, 3000);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
  }, [order, router]);
  return null;
}
