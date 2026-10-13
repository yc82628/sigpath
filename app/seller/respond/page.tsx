"use client";

import { useEffect, useState } from "react";
import { useLang } from "../../components/I18n";

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
  en: { counterfeit: "Reported as not genuine", not_as_described: "Reported as materially different from the listing" },
  de: { counterfeit: "Als nicht echt gemeldet", not_as_described: "Als wesentlich abweichend vom Angebot gemeldet" },
} as const;

const STATUS = {
  en: {
    pending: "Under review — nothing has been published",
    upheld: "Upheld after review",
    reversed: "Upheld, then reversed",
    dismissed: "Dismissed — nothing was published",
    expired: "Closed without review — nothing was published",
  },
  de: {
    pending: "In Prüfung: nichts wurde veröffentlicht",
    upheld: "Nach Prüfung bestätigt",
    reversed: "Bestätigt, dann aufgehoben",
    dismissed: "Abgewiesen: nichts wurde veröffentlicht",
    expired: "Ohne Prüfung geschlossen: nichts wurde veröffentlicht",
  },
} as const;

/** The page's words: English, or German on a German page. */
function useT() {
  const de = useLang() === "de";
  return { lang: de ? ("de" as const) : ("en" as const), T: (en: string, german: string) => (de ? german : en) };
}

function day(s: number) {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

function ResponseForm({ token, finding, onDone }: { token: string; finding: Finding; onDone: () => void }) {
  const { T } = useT();
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
      if (!res.ok) throw new Error(body.error ?? T("Could not submit.", "Konnte nicht gesendet werden."));
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
            ? T("Your reply — the reviewer reads it before deciding. 10–1,000 characters.", "Deine Antwort: Die prüfende Person liest sie vor der Entscheidung. 10–1.000 Zeichen.")
            : T(
                "Your appeal — ask for this finding to be reversed, and say why. 10–1,000 characters.",
                "Dein Einspruch: Bitte darum, diesen Befund aufzuheben, und sag warum. 10–1.000 Zeichen.",
              )}
        </span>
        <textarea value={text} maxLength={1000} rows={5} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="hint">
        {kind === "reply"
          ? T(
              "You can submit one reply. It will be shown publicly beside the finding if one is made, so write it for anyone to read. Don't include anyone's personal details.",
              "Du kannst eine Antwort senden. Sie wird öffentlich neben dem Befund gezeigt, falls es einen gibt: Schreib sie also für alle lesbar. Nenne keine persönlichen Daten.",
            )
          : T(
              "You can submit one appeal. It will be shown publicly beside the finding, so write it for anyone to read. Don't include anyone's personal details.",
              "Du kannst einen Einspruch senden. Er wird öffentlich neben dem Befund gezeigt: Schreib ihn also für alle lesbar. Nenne keine persönlichen Daten.",
            )}
      </p>
      <button type="submit" className="primary" disabled={busy || text.trim().length < 10}>
        {busy ? T("Submitting…", "Wird gesendet…") : kind === "reply" ? T("Submit reply", "Antwort senden") : T("Submit appeal", "Einspruch senden")}
      </button>
      {error && <p className="notice withheld">{error}</p>}
    </form>
  );
}

export default function SellerRespondPage() {
  const { T, lang } = useT();
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
      if (!res.ok) throw new Error(body.error ?? T("Could not load.", "Konnte nicht geladen werden."));
      setSeller(body.seller);
      setFindings(body.findings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    if (!t) {
      setError(T("This page needs the private link from SigPath's message. Open it from that message.", "Diese Seite braucht den privaten Link aus SigPaths Nachricht. Öffne sie über diese Nachricht."));
      return;
    }
    setToken(t);
    void load(t);
  }, []);

  return (
    <main className="container">
      <h1>{T("Respond to a report", "Auf eine Meldung antworten")}</h1>
      <p className="lede">
        {T(
          "A buyer SigPath purchased from you has reported what they received. Nothing about you is published unless a reviewer upholds the report — and not before you've had the chance to answer it.",
          "Ein Käufer, für den SigPath bei dir gekauft hat, hat gemeldet, was er erhalten hat. Über dich wird nichts veröffentlicht, solange eine prüfende Person die Meldung nicht bestätigt, und nicht, bevor du darauf antworten konntest.",
        )}
      </p>

      {error && <p className="notice withheld">{error}</p>}
      {seller && (
        <p className="hint">
          {T("Reports about ", "Meldungen zu ")}
          <strong>{seller}</strong>
        </p>
      )}
      {findings && findings.length === 0 && <p className="hint">{T("There are no reports about you.", "Es gibt keine Meldungen zu dir.")}</p>}

      {findings?.map((f) => (
        <article key={f.order} className="listing">
          <div className="body">
            <h3>{f.category ? CATEGORY[lang][f.category] : T("Report", "Meldung")}</h3>
            <p className="meta">
              {STATUS[lang][f.status]} &middot; {T("filed", "eingereicht am")} {day(f.filedAt)}
              {f.decidedAt && (
                <>
                  {" "}
                  &middot; {T("decided", "entschieden am")} {day(f.decidedAt)}
                </>
              )}
              {f.reversedAt && (
                <>
                  {" "}
                  &middot; {T("reversed", "aufgehoben am")} {day(f.reversedAt)}
                </>
              )}
            </p>
            {f.listing && (
              <p className="meta">
                {T("Listing:", "Angebot:")}{" "}
                <a href={f.listing.url} target="_blank" rel="noopener noreferrer">
                  {f.listing.title}
                </a>
              </p>
            )}
            {f.buyerDescription && (
              <blockquote className="quote">
                <span className="hint">{T("The buyer wrote:", "Der Käufer schrieb:")}</span>
                <br />
                {f.buyerDescription}
              </blockquote>
            )}
            {f.status === "pending" && f.replyBy && !f.reply && (
              <p className="notice">
                {T("You have until ", "Du hast bis zum ")}
                <strong>{day(f.replyBy)}</strong>
                {T(" to reply. After that the report can be decided without your reply.", " Zeit zu antworten. Danach kann ohne deine Antwort entschieden werden.")}
              </p>
            )}
            {f.reply && (
              <blockquote className="quote">
                <span className="hint">
                  {T("Your reply", "Deine Antwort")} ({day(f.reply.at)}):
                </span>
                <br />
                {f.reply.text}
              </blockquote>
            )}
            {f.appeal && (
              <blockquote className="quote">
                <span className="hint">
                  {T("Your appeal", "Dein Einspruch")} ({day(f.appeal.at)}):
                </span>
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
