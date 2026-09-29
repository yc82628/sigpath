"use client";

import { useEffect, useState } from "react";

/**
 * app/seller/respond — where a reported seller answers.
 *
 * Reached only through the private link in SigPath's notice, sent through the
 * marketplace's messages on the order SigPath placed. The token is read from
 * the URL FRAGMENT, which the browser never sends to a server, and is kept in
 * page memory only — no cookie, no localStorage.
 */

interface Response {
  text: string;
  at: number;
}

interface Finding {
  order: string;
  status: "pending" | "upheld" | "reversed" | "dismissed" | "expired";
  category?: "counterfeit" | "not_as_described";
  filedAt: number;
  decidedAt?: number;
  reversedAt?: number;
  listing?: { title: string; url: string };
  buyerDescription?: string;
  replyBy?: number;
  reply?: Response;
  appeal?: Response;
  canReply: boolean;
  canAppeal: boolean;
}

const CATEGORY = {
  counterfeit: "Reported as not genuine",
  not_as_described: "Reported as materially different from the listing",
} as const;

const STATUS = {
  pending: "Under review — nothing has been published",
  upheld: "Upheld after review",
  reversed: "Upheld, then reversed",
  dismissed: "Dismissed — nothing was published",
  expired: "Closed without review — nothing was published",
} as const;

function day(s: number) {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

function ResponseForm({ token, finding, onDone }: { token: string; finding: Finding; onDone: () => void }) {
  const kind = finding.canReply ? "reply" : "appeal";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/sellers/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, order: finding.order, text }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not submit.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="report-form">
      <label className="stacked">
        <span>
          {kind === "reply"
            ? "Your reply — the reviewer reads it before deciding. 10–1,000 characters."
            : "Your appeal — ask for this finding to be reversed, and say why. 10–1,000 characters."}
        </span>
        <textarea value={text} maxLength={1000} rows={5} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="hint">
        You can submit one {kind}. It will be shown publicly beside the finding if one is made, so
        write it for anyone to read. Don&apos;t include anyone&apos;s personal details.
      </p>
      <button type="submit" className="primary" disabled={busy || text.trim().length < 10}>
        {busy ? "Submitting…" : kind === "reply" ? "Submit reply" : "Submit appeal"}
      </button>
      {error && <p className="notice withheld">{error}</p>}
    </form>
  );
}

export default function SellerRespondPage() {
  const [token, setToken] = useState<string | null>(null);
  const [seller, setSeller] = useState("");
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState("");

  async function load(t: string) {
    setError("");
    try {
      const res = await fetch("/api/sellers/findings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: t }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load.");
      setSeller(body.seller);
      setFindings(body.findings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    if (!t) {
      setError("This page needs the private link from SigPath's message. Open it from that message.");
      return;
    }
    setToken(t);
    void load(t);
  }, []);

  return (
    <main className="container">
      <h1>Respond to a report</h1>
      <p className="lede">
        A buyer SigPath purchased from you has reported what they received. Nothing about you is
        published unless a reviewer upholds the report — and not before you&apos;ve had the chance to
        answer it.
      </p>

      {error && <p className="notice withheld">{error}</p>}
      {seller && <p className="hint">Reports about <strong>{seller}</strong></p>}
      {findings && findings.length === 0 && <p className="hint">There are no reports about you.</p>}

      {findings?.map((f) => (
        <article key={f.order} className="listing">
          <div className="body">
            <h3>{f.category ? CATEGORY[f.category] : "Report"}</h3>
            <p className="meta">
              {STATUS[f.status]} &middot; filed {day(f.filedAt)}
              {f.decidedAt && <> &middot; decided {day(f.decidedAt)}</>}
              {f.reversedAt && <> &middot; reversed {day(f.reversedAt)}</>}
            </p>
            {f.listing && (
              <p className="meta">
                Listing:{" "}
                <a href={f.listing.url} target="_blank" rel="noopener noreferrer">
                  {f.listing.title}
                </a>
              </p>
            )}
            {f.buyerDescription && (
              <blockquote className="quote">
                <span className="hint">The buyer wrote:</span>
                <br />
                {f.buyerDescription}
              </blockquote>
            )}
            {f.status === "pending" && f.replyBy && !f.reply && (
              <p className="notice">
                You have until <strong>{day(f.replyBy)}</strong> to reply. After that the report can be
                decided without your reply.
              </p>
            )}
            {f.reply && (
              <blockquote className="quote">
                <span className="hint">Your reply ({day(f.reply.at)}):</span>
                <br />
                {f.reply.text}
              </blockquote>
            )}
            {f.appeal && (
              <blockquote className="quote">
                <span className="hint">Your appeal ({day(f.appeal.at)}):</span>
                <br />
                {f.appeal.text}
              </blockquote>
            )}
            {token && (f.canReply || f.canAppeal) && (
              <ResponseForm token={token} finding={f} onDone={() => void load(token)} />
            )}
          </div>
        </article>
      ))}
    </main>
  );
}
