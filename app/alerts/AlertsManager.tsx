"use client";

import { useEffect, useState } from "react";
import { existingSubscription, pushSupported } from "../components/push";
import { useLang, useMessages } from "../components/I18n";
import { moneyText } from "@/lib/i18n/money";

type Money = { amount: number; currency: string };
type W = { id: string; query: string; group: "new" | "used"; target: Money; expiresAt: number; lastAlerted?: Money };



/** This browser's alerts, found by its own push endpoint — there is nothing else to log in with. */
export default function AlertsManager() {
  const m = useMessages();
  const lang = useLang();
  const money = (x: Money) => moneyText(x, lang);
  const [supported, setSupported] = useState(true);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [watches, setWatches] = useState<W[] | null>(null);
  const [error, setError] = useState("");

  async function post(path: string, body: object) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status}).`);
    return data;
  }

  useEffect(() => {
    (async () => {
      if (!pushSupported()) return setSupported(false);
      try {
        const sub = await existingSubscription();
        if (!sub) return setWatches([]);
        setEndpoint(sub.endpoint);
        setWatches((await post("/api/alerts/list", { endpoint: sub.endpoint })).watches);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  async function remove(id?: string) {
    if (!endpoint) return;
    try {
      await post("/api/alerts/delete", id ? { endpoint, id } : { endpoint, all: true });
      setWatches((ws) => (id ? (ws ?? []).filter((w) => w.id !== id) : []));
      if (!id) await (await existingSubscription())?.unsubscribe();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!supported) return <p className="notice withheld">{m.alerts.unsupported}</p>;
  if (error) return <p className="notice withheld">{error}</p>;
  if (watches === null) return <p className="hint">{m.alerts.loading}</p>;
  if (!watches.length) {
    return (
      <p className="notice">
        {m.alerts.none}
      </p>
    );
  }

  return (
    <div>
      {watches.map((w) => (
        <article key={w.id} className="listing">
          <div className="body">
            <h3>
              <a href={`/search?q=${encodeURIComponent(w.query)}&checked=1`}>{w.query}</a>
            </h3>
            <p className="meta">
              {w.group === "used" ? m.search.usedWord : m.search.newWord} &middot; {m.alerts.atOrUnder(money(w.target))} &middot;{" "}
              {m.alerts.until(new Date(w.expiresAt * 1000).toISOString().slice(0, 10))}
              {w.lastAlerted && <> &middot; {m.alerts.lastAlerted(money(w.lastAlerted))}</>}
            </p>
          </div>
          <div className="price">
            <button type="button" onClick={() => remove(w.id)}>
              {m.alerts.delete}
            </button>
          </div>
        </article>
      ))}
      <p className="hint" style={{ marginTop: 16 }}>
        <button type="button" onClick={() => remove()}>
          {m.alerts.deleteAll}
        </button>
      </p>
    </div>
  );
}
