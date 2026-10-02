"use client";

import { useState } from "react";
import { subscribe, toMinorUnits } from "./push";

/**
 * "Alert me" for one search and condition. Only SigPath-checked deals fire —
 * the copy says so, because that's the point: no "price drop!" for bait.
 */
export default function AlertButton({
  query,
  group,
  current,
  vapidKey,
}: {
  query: string;
  group: "new" | "used";
  current: { amount: number; currency: string };
  vapidKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(((current.amount - 1) / 100).toFixed(2));
  const [state, setState] = useState<"idle" | "busy" | "set" | "error">("idle");
  const [message, setMessage] = useState("");

  async function create() {
    const amount = toMinorUnits(target);
    if (!amount) {
      setState("error");
      setMessage("Enter a price, like 349.99.");
      return;
    }
    try {
      setState("busy");
      const sub = await subscribe(vapidKey);
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), query, group, target: { amount, currency: current.currency } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The alert couldn't be saved.");
      setState("set");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (state === "set") {
    return (
      <p className="alert-set">
        &#128276; Alert set. This browser gets a notification when a SigPath-checked {group} deal is at or under {target}{" "}
        {current.currency}, for 30 days. <a href="/alerts">Manage alerts</a>
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" className="alert-open" onClick={() => setOpen(true)}>
        &#128276; Alert me if it drops
      </button>
    );
  }
  return (
    <div className="alert-form">
      <label>
        Notify me when a <strong>SigPath-checked</strong> {group} deal is at or under{" "}
        <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} size={9} aria-label="Target price" />{" "}
        {current.currency}
      </label>{" "}
      <button type="button" className="primary" disabled={state === "busy"} onClick={create}>
        Turn on alert
      </button>
      <p className="hint">
        No account or email: your browser asks permission to show notifications. SigPath keeps the search, the price and an
        anonymous browser address for 30 days, and you can delete them any time. Flagged or unchecked listings never trigger
        an alert.
      </p>
      {state === "error" && <p className="notice withheld">{message}</p>}
    </div>
  );
}
