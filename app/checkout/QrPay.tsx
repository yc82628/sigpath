"use client";

import { useEffect, useRef, useState } from "react";
import { DEVNET, isMobileDevice, waitForPayment } from "../components/wallet";
import { useCheckText, useLang, useMessages } from "../components/I18n";
import { usdc } from "@/lib/i18n/money";

/**
 * Pay by scanning a QR code with a phone wallet (lib/checkout/pay-session.ts).
 *
 * "Show the QR code" sends the signed prices and the address once, as the
 * wallet checkout does, and gets back a Solana Pay link; the code holds it.
 * Then this asks every two seconds what the scan did: nothing yet, a wallet
 * that couldn't pay (and why: the same code can be scanned again after a
 * top-up), or the orders it created, which are then followed on SigPath's own
 * network to paid, failed or expired, as every payment is.
 */

type Order = { order: string; source: string; id: string; title: string };
type Phase = "idle" | "creating" | "waiting" | "scanned" | "error";

export default function QrPay({
  quotes,
  address,
  validate,
  disabled,
  onPaid,
  onPriceExpired,
}: {
  quotes: string[];
  address: Record<string, string>;
  /** The form's own check of the address fields, before anything is sent. */
  validate: () => boolean;
  disabled?: boolean;
  onPaid: (orders: Order[], confirmed: boolean) => void;
  onPriceExpired: () => void;
}) {
  const m = useMessages();
  const lang = useLang();
  const tc = useCheckText();
  const q = m.checkout.qr;
  const [phase, setPhase] = useState<Phase>("idle");
  const [svg, setSvg] = useState("");
  const [link, setLink] = useState("");
  const [until, setUntil] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [mobile, setMobile] = useState(false);
  // One QR code at a time: a new one, or leaving the page, stops the old one's polling.
  const run = useRef(0);
  useEffect(() => {
    setMobile(isMobileDevice(navigator.userAgent, navigator.maxTouchPoints));
    return () => {
      run.current++;
    };
  }, []);

  async function start() {
    if (!validate()) return;
    const mine = ++run.current;
    setPhase("creating");
    setNote("");
    setSvg("");
    try {
      const res = await fetch("/api/pay/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quotes, address }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.code === "quote_expired") onPriceExpired();
      if (!res.ok) throw new Error(body.error ?? `(${res.status})`);
      const QR = await import("qrcode");
      const drawn = await QR.toString(body.link, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b0a1a", light: "#ffffff" } });
      if (mine !== run.current) return;
      setSvg(drawn);
      setLink(body.link);
      setUntil(body.expiresAt);
      setPhase("waiting");
      await follow(body.id, mine);
    } catch (err) {
      if (mine !== run.current) return;
      setPhase("error");
      setNote(tc(err instanceof Error ? err.message : String(err)));
    }
  }

  async function follow(id: string, mine: number) {
    while (mine === run.current) {
      await new Promise((r) => setTimeout(r, 2000));
      if (mine !== run.current) return;
      let s: { state: string; orders?: Order[]; validUntil?: number; message?: string; shortfallUsdc?: number };
      try {
        s = await (await fetch(`/api/pay/${id}/status`, { cache: "no-store" })).json();
      } catch {
        continue; // the network or the server didn't answer: ask again
      }
      if (s.state === "gone") {
        setPhase("error");
        setSvg("");
        setNote(q.gone);
        return;
      }
      if (s.state === "failed") {
        // The wallet couldn't pay (short of USDC, a price run out): said, and the same code still works.
        setNote(s.shortfallUsdc ? q.short(usdc(String(Math.ceil(s.shortfallUsdc * 1e6)), lang)) : q.failed(tc(s.message ?? "")));
        continue;
      }
      if (s.state === "scanned" && s.orders?.length) {
        setPhase("scanned");
        setNote(q.scanned);
        const outcome = await waitForPayment(s.orders[0].order, null, s.validUntil ?? null);
        if (mine !== run.current) return;
        if (outcome.state === "paid") return onPaid(s.orders, true);
        if (outcome.state === "pending") return onPaid(s.orders, false);
        setPhase("error");
        setSvg("");
        setNote(outcome.state === "failed" ? m.checkout.failedOnChain(outcome.reason ?? "rejected") : q.expired(DEVNET));
        return;
      }
    }
  }

  const time = until ? new Date(until).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="qr-pay">
      {svg && phase !== "error" ? (
        <div className="qr-box">
          {/* The library's own SVG of the Solana Pay link: no outside input reaches it but that link. */}
          <div className="qr-code" role="img" aria-label={q.alt} dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="qr-text">
            <ol>
              {q.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {DEVNET && <p className="hint">{q.devnet}</p>}
            {mobile && link && (
              <p>
                <a className="button ghost" href={link}>
                  {q.openHere}
                </a>
              </p>
            )}
            <p className="qr-state" role="status">
              <span className="spinner" aria-hidden="true" /> {phase === "scanned" ? q.scanned : q.waiting}
            </p>
            {time && <p className="hint">{q.until(time)}</p>}
          </div>
        </div>
      ) : (
        <button type="button" className="primary" onClick={start} disabled={disabled || phase === "creating"}>
          {phase === "creating" ? m.checkout.working : phase === "error" ? q.again : q.show}
        </button>
      )}
      {note && phase !== "scanned" && (
        <p className={phase === "error" ? "notice withheld" : "notice"} role="status">
          {note}
        </p>
      )}
    </div>
  );
}
