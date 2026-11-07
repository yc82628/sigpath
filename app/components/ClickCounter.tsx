"use client";

import { useEffect } from "react";

/**
 * Counts a click on a search result that leads to the marketplace (lib/stats/counter.ts).
 * Only "a click happened" is sent: not the listing, the search or anything about the shopper.
 * The link opens as usual; the count goes by sendBeacon, so it never holds the click up.
 */
export default function ClickCounter() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !a.closest("main")) return;
      let out: URL;
      try {
        out = new URL(a.href);
      } catch {
        return;
      }
      if (out.origin === location.origin || !/^https?:$/.test(out.protocol)) return;
      try {
        navigator.sendBeacon("/api/stats/click");
      } catch {
        // Not counted; the link still opens.
      }
    };
    // Middle clicks open a tab too.
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
    };
  }, []);
  return null;
}
