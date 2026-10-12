"use client";

import { useState } from "react";
import { subscribe, toMinorUnits } from "./push";
import { useLang, useMessages } from "./I18n";

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
  const m = useMessages();
  const lang = useLang();
  const groupWord = group === "used" ? m.search.usedWord : m.search.newWord;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(((current.amount - 1) / 100).toFixed(2));
  const [state, setState] = useState<"idle" | "busy" | "set" | "error">("idle");
  const [message, setMessage] = useState("");

  async function create() {
    const amount = toMinorUnits(target);
    if (!amount) {
      setState("error");
      setMessage(m.alerts.enterPrice);
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
      if (!res.ok) throw new Error(body.error ?? m.alerts.saveFailed);
      setState("set");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (state === "set") {
    return (
      <p className="alert-set">
        {m.alerts.set(lang === "de" ? group : groupWord, `${target} ${current.currency}`)} <a href="/alerts">{m.alerts.manage}</a>
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" className="alert-open" onClick={() => setOpen(true)}>
        {m.alerts.open}
      </button>
    );
  }
  return (
    <div className="alert-form">
      <label>
        {m.alerts.notify(lang === "de" ? group : groupWord)}{" "}
        <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} size={9} aria-label={m.alerts.target} />{" "}
        {current.currency}
      </label>{" "}
      <button type="button" className="primary" disabled={state === "busy"} onClick={create}>
        {m.alerts.turnOn}
      </button>
      <p className="hint">
        {m.alerts.explain}
      </p>
      {state === "error" && <p className="notice withheld">{message}</p>}
    </div>
  );
}
