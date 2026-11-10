"use client";

import { useEffect, useRef } from "react";

/**
 * Applies the search filters as soon as a choice changes, on a wide screen.
 *
 * Radios, checkboxes and menus submit their form at once; typed prices wait
 * for Enter or the button. On a phone the filters sit in a drawer where people
 * pick several things and then press "Show results", so nothing is sent until
 * they do. Without JavaScript the button does it everywhere, and the address
 * just carries the empty fields too.
 */
export default function AutoSubmit({ minWidth = 900 }: { minWidth?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const onChange = (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (!window.matchMedia(`(min-width: ${minWidth}px)`).matches) return;
      if (t.type === "radio" || t.type === "checkbox" || t.tagName === "SELECT") form.requestSubmit();
    };
    // A clean address: choices left on "any" or empty aren't sent ("…&min=&max=&storage=").
    const onSubmit = (e: SubmitEvent) => {
      const params = new URLSearchParams();
      for (const [k, v] of new FormData(form)) {
        if (typeof v === "string" && v !== "" && !(k === "cond" && v === "any")) params.append(k, v);
      }
      e.preventDefault();
      window.location.assign(`${form.getAttribute("action") ?? ""}?${params}`);
    };
    form.addEventListener("change", onChange);
    form.addEventListener("submit", onSubmit);
    return () => {
      form.removeEventListener("change", onChange);
      form.removeEventListener("submit", onSubmit);
    };
  }, [minWidth]);
  return <span ref={ref} hidden />;
}
