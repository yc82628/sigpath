"use client";

import { useEffect, useState } from "react";

/**
 * False while the server draws the page and during the first draw in the
 * browser, true from then on. For anything that depends on the shopper's own
 * clock or timezone ("price held until 17:47"): the server runs on UTC and
 * can't know either, and drawing it there makes the browser's first draw
 * disagree with the server's, which React answers by redrawing the whole page.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
