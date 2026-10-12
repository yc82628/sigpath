"use client";

import { useEffect } from "react";

/**
 * A link to a folded section (/privacy#extension, the Chrome Web Store's
 * privacy link) opens that section, rather than landing on a closed heading.
 */
export default function OpenFromHash() {
  useEffect(() => {
    const open = () => {
      const el = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.scrollIntoView({ block: "start" });
      }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return null;
}
