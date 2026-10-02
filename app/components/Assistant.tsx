"use client";

/**
 * The shopping assistant: a chat panel opened from a floating button.
 *
 * The conversation lives only in this component's state (gone on reload) and
 * is sent with each turn to /api/assistant, which streams back words, a
 * "searching" note and result cards (see lib/assistant/assistant.ts).
 */

import { useEffect, useRef, useState } from "react";
import type { AssistantEvent } from "@/lib/assistant/assistant";
import type { AssistantCard, AssistantResults } from "@/lib/assistant/search-tool";

interface Turn {
  role: "user" | "assistant";
  content: string;
  searching?: string;
  results?: AssistantResults[];
}

const SUGGESTIONS = ["A used ThinkPad under €400", "AirPods Pro, checked deals only", "A handmade gift under €50"];

const VERDICT_LABEL: Record<AssistantCard["verdict"], string> = {
  checked: "✓ Checked",
  caution: "! Look closer",
  unchecked: "Not price-checked",
};

function Card({ c }: { c: AssistantCard }) {
  // Listing URLs come from marketplaces: link only to http(s).
  const href = /^https?:\/\//i.test(c.url) ? c.url : undefined;
  return (
    <li className={`chat-card ${c.verdict}`}>
      <span className={`chat-verdict ${c.verdict}`}>{VERDICT_LABEL[c.verdict]}</span>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="chat-card-title">
          {c.title}
        </a>
      ) : (
        <span className="chat-card-title">{c.title}</span>
      )}
      <span className="chat-card-meta">
        <strong>{c.total}</strong> · {c.marketplace} · {c.condition}
        {c.verifiedSeller ? " · verified seller" : ""}
      </span>
      {c.verdict === "caution" && c.reasons[0] && <span className="chat-card-why">{c.reasons[0]}</span>}
    </li>
  );
}

function Results({ r }: { r: AssistantResults }) {
  if (r.shown.length === 0) return <p className="chat-note">No listings matched every preference.</p>;
  return (
    <div className="chat-results">
      <ul>
        {r.shown.map((c) => (
          <Card key={c.id} c={c} />
        ))}
      </ul>
      <a className="chat-see-all" href={r.seeAll}>
        See all {r.found} results &rarr;
      </a>
    </div>
  );
}

export default function Assistant() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  /** Apply one streamed event to the assistant turn being written (always the last). */
  function apply(e: AssistantEvent) {
    setTurns((ts) => {
      const last = { ...ts[ts.length - 1] };
      if (e.type === "text") last.content += e.text;
      else if (e.type === "searching") last.searching = e.query;
      else if (e.type === "results") {
        last.results = [...(last.results ?? []), e.results];
        last.searching = undefined;
      }
      return [...ts.slice(0, -1), last];
    });
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setError(null);
    setInput("");
    setBusy(true);
    const history = [...turns, { role: "user" as const, content: message }];
    setTurns([...history, { role: "assistant", content: "" }]);

    let failure: string | null = null;
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      if (!res.ok || !res.body) {
        failure = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Something went wrong. Please try again.";
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const e = JSON.parse(line) as AssistantEvent;
            if (e.type === "error") failure = e.message;
            else if (e.type !== "done") apply(e);
          }
        }
      }
    } catch {
      failure = "Couldn't reach SigPath. Check your connection and try again.";
    }

    setTurns((ts) => {
      const last = ts[ts.length - 1];
      // A turn that produced nothing is taken back, and the question returned to the box.
      if (failure && !last.content && !last.results) {
        setInput(message);
        return ts.slice(0, -2);
      }
      return last.content ? ts : [...ts.slice(0, -1), { ...last, content: "Here's what I found." }];
    });
    if (failure) setError(failure);
    setBusy(false);
    inputRef.current?.focus();
  }

  if (!open) {
    return (
      <button type="button" className="chat-launcher" onClick={() => setOpen(true)} aria-label="Open the shopping assistant">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
        </svg>
        <span>Ask SigPath</span>
      </button>
    );
  }

  return (
    <section className="chat-panel" role="dialog" aria-label="Shopping assistant" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <header className="chat-head">
        <div>
          <strong>Shopping assistant</strong>
          <span>Tell me what you&apos;re after</span>
        </div>
        <button type="button" className="chat-close" onClick={() => setOpen(false)} aria-label="Close the assistant">
          &times;
        </button>
      </header>

      <div className="chat-body" aria-live="polite">
        {turns.length === 0 && (
          <div className="chat-welcome">
            <p>Describe what you want, with your budget and must-haves. I&apos;ll search eBay, Amazon and Etsy and pick the checked deals.</p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn ${t.role}`}>
            {t.content && <p className="chat-bubble">{t.content}</p>}
            {t.searching && <p className="chat-note">Searching for &ldquo;{t.searching}&rdquo;&hellip;</p>}
            {t.results?.map((r, j) => <Results key={j} r={r} />)}
            {t.role === "assistant" && busy && i === turns.length - 1 && !t.content && !t.searching && !t.results && (
              <p className="chat-typing" aria-label="Thinking">
                <span />
                <span />
                <span />
              </p>
            )}
          </div>
        ))}
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. used camera under €500"
          aria-label="Message the shopping assistant"
          maxLength={2000}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
      <p className="chat-foot">Answers by Claude. Chats aren&apos;t saved. Please don&apos;t share personal details.</p>
    </section>
  );
}
