"use client";

import { useState } from "react";
import CameraCapture, { type CaptureChallenge, type FrameResult } from "../../components/CameraCapture";
import WalletButton from "../../components/WalletButton";
import { walletErrorMessage, type ConnectedWallet } from "../../components/wallet";

/**
 * Report a fake product, in three steps the buyer can see:
 *
 *   1. say what was wrong
 *   2. prove you are the buyer — sign a message with the wallet that paid
 *      (a signature over text, not a transaction: nothing moves)
 *   3. prove you have the item — a live photo of it beside a code issued now
 *
 * Nothing is kept in the browser: no localStorage, no cookie. The photo goes to
 * the server once, is judged, and is stored encrypted for the reviewer only.
 */

const CATEGORIES = [
  { value: "counterfeit", label: "It's a counterfeit — not the genuine product" },
  { value: "not_as_described", label: "It's materially different from the listing" },
] as const;

type Step = "describe" | "signing" | "capture" | "filed" | "error";

export default function ReportForm({ order }: { order: string }) {
  const [category, setCategory] = useState<string>("");
  const [description, setDescription] = useState("");
  const [step, setStep] = useState<Step>("describe");
  const [message, setMessage] = useState("");
  const [intent, setIntent] = useState<{ intentId: string; signature: string } | null>(null);

  const ready = category !== "" && description.trim().length >= 10 && description.length <= 500;

  function walletError(text: string) {
    setStep("error");
    setMessage(text);
  }

  async function signAsBuyer(wallet: ConnectedWallet) {
    setStep("signing");
    try {
      const res = await fetch("/api/reports/intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order, wallet: wallet.address }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Couldn't start the report (${res.status}).`);

      setMessage(`Sign the message in ${wallet.name}. It moves no funds — it only proves you're the buyer.`);
      const signature = await wallet.signMessage(body.message);
      setIntent({ intentId: body.intentId, signature });
      setStep("capture");
      setMessage("");
    } catch (err) {
      setStep("error");
      setMessage(walletErrorMessage(err));
    }
  }

  async function requestChallenge(): Promise<CaptureChallenge> {
    const res = await fetch("/api/reports/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: intent!.intentId, signature: intent!.signature }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Couldn't start the camera check.");
    return body;
  }

  async function submitFrame(frame: { sessionId: string; imageBase64: string; mediaType: string }): Promise<FrameResult> {
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: intent!.intentId, ...frame, category, description }),
    });
    const body = await res.json();
    if (res.status === 503) return { kind: "unavailable", detail: body.error ?? "try again" };
    if (!res.ok) return { kind: "judged", passed: false, reason: body.error ?? "The report could not be filed." };
    return body.passed
      ? { kind: "judged", passed: true, reason: "" }
      : { kind: "judged", passed: false, reason: body.reason ?? "The photo didn't pass." };
  }

  if (step === "filed") {
    return (
      <div className="notice">
        <p>
          <strong>Report filed.</strong> A reviewer will look at your evidence. Nothing about the
          seller changes until a reviewer upholds it — and your photo, description and wallet are
          deleted as soon as it&apos;s decided.
        </p>
      </div>
    );
  }

  return (
    <div className="report-form">
      <fieldset disabled={step !== "describe" && step !== "error"}>
        <legend>1. What was wrong?</legend>
        {CATEGORIES.map((c) => (
          <label key={c.value} className="radio">
            <input
              type="radio"
              name="category"
              value={c.value}
              checked={category === c.value}
              onChange={() => setCategory(c.value)}
            />
            <span>{c.label}</span>
          </label>
        ))}
        <label className="stacked">
          <span>Describe it — what you expected, what arrived, how you can tell (10–500 characters)</span>
          <textarea value={description} maxLength={500} rows={4} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </fieldset>

      {(step === "describe" || step === "error") && (
        <>
          <p className="hint">2. Prove you&apos;re the buyer — sign with the wallet that paid.</p>
          <WalletButton label="Connect wallet and sign" disabled={!ready} onConnect={signAsBuyer} onError={walletError} />
        </>
      )}

      {step === "capture" && intent && (
        <section>
          <p className="hint">3. Prove you have the item.</p>
          <CameraCapture
            facingMode="environment"
            requestChallenge={requestChallenge}
            submitFrame={submitFrame}
            onComplete={() => setStep("filed")}
            intro={
              <p>
                You&apos;ll get a one-time code and <strong>90 seconds</strong>. Write it on paper,
                place it next to the item you received, and photograph both. Camera only — there is no
                upload, so the evidence is current and yours.
              </p>
            }
          />
        </section>
      )}

      {message && <p className={step === "error" ? "notice withheld" : "hint"}>{message}</p>}
    </div>
  );
}
