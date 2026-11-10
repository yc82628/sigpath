"use client";

import { useEffect } from "react";

/**
 * Registers SigPath's service worker (public/sw.js) on every page, so a phone
 * can install SigPath as an app and put it in the share menu (app/manifest.ts).
 * The worker only handles price-alert pushes: it doesn't cache pages or see
 * requests. Registering twice (the alerts page does too) is the same worker.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const go = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    // After the page has loaded: never in the way of the first paint.
    if (document.readyState === "complete") go();
    else window.addEventListener("load", go, { once: true });
  }, []);
  return null;
}
