"use client";

import { useEffect, useState } from "react";
import { existingSubscription, pushSupported } from "../components/push";

type Money = { amount: number; currency: string };
type W = { id: string; query: string; group: "new" | "used"; target: Money; expiresAt: number; lastAlerted?: Money };

const money = (m: Money) => `${(m.amount / 100).toFixed(2)} ${m.currency}`;

/** This browser's alerts, found by its own push endpoint — there is nothing else to log in with. */
export default function AlertsManager() {
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

  if (!supported) return <p className="notice withheld">This browser can&apos;t receive notifications from websites.</p>;
  if (error) return <p className="notice withheld">{error}</p>;
  if (watches === null) return <p className="hint">Loading&hellip;</p>;
  if (!watches.length) {
    return (
      <p className="notice">
        No alerts in this browser. Search for something and use &ldquo;Alert me if it drops&rdquo; under the best checked deal.
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
              {w.group} &middot; at or under {money(w.target)} &middot; until{" "}
              {new Date(w.expiresAt * 1000).toISOString().slice(0, 10)}
              {w.lastAlerted && <> &middot; last alerted at {money(w.lastAlerted)}</>}
            </p>
          </div>
          <div className="price">
            <button type="button" onClick={() => remove(w.id)}>
              Delete
            </button>
          </div>
        </article>
      ))}
      <p className="hint" style={{ marginTop: 16 }}>
        <button type="button" onClick={() => remove()}>
          Delete all and turn off notifications
        </button>
      </p>
    </div>
  );
}
