"use client";

import { useState } from "react";
import CameraCapture, { type CaptureChallenge, type FrameResult } from "../../components/CameraCapture";
import WalletButton from "../../components/WalletButton";
import { walletErrorMessage, type ConnectedWallet } from "../../components/wallet";
import { useLang } from "../../components/I18n";

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

const en = {
  categories: [
    { value: "counterfeit", label: "It's a counterfeit — not the genuine product" },
    { value: "not_as_described", label: "It's materially different from the listing" },
  ],
  startFailed: (status: number) => `Couldn't start the report (${status}).`,
  sign: (wallet: string) => `Sign the message in ${wallet}. It moves no funds — it only proves you're the buyer.`,
  cameraFailed: "Couldn't start the camera check.",
  tryAgain: "try again",
  notFiled: "The report could not be filed.",
  photoFailed: "The photo didn't pass.",
  filedStrong: "Report filed.",
  filed: " A reviewer will look at your evidence. Nothing about the seller changes until a reviewer upholds it — and your photo, description and wallet are deleted as soon as it's decided.",
  step1: "1. What was wrong?",
  describe: "Describe it — what you expected, what arrived, how you can tell (10–500 characters)",
  step2: "2. Prove you're the buyer — sign with the wallet that paid.",
  connectSign: "Connect wallet and sign",
  step3: "3. Prove you have the item.",
  introA: "You'll get a one-time code and ",
  introStrong: "90 seconds",
  introB: ". Write it on paper, place it next to the item you received, and photograph both. Camera only — there is no upload, so the evidence is current and yours.",
};
const de: typeof en = {
  categories: [
    { value: "counterfeit", label: "Es ist eine Fälschung, nicht das Originalprodukt" },
    { value: "not_as_described", label: "Es weicht wesentlich vom Angebot ab" },
  ],
  startFailed: (status) => `Die Meldung konnte nicht gestartet werden (${status}).`,
  sign: (wallet) => `Signiere die Nachricht in ${wallet}. Dabei wird kein Geld bewegt; sie beweist nur, dass du der Käufer bist.`,
  cameraFailed: "Die Kameraprüfung konnte nicht gestartet werden.",
  tryAgain: "versuche es erneut",
  notFiled: "Die Meldung konnte nicht eingereicht werden.",
  photoFailed: "Das Foto hat die Prüfung nicht bestanden.",
  filedStrong: "Meldung eingereicht.",
  filed: " Eine prüfende Person sieht sich deine Belege an. Für den Verkäufer ändert sich nichts, bis die Meldung bestätigt ist, und dein Foto, deine Beschreibung und deine Wallet werden gelöscht, sobald entschieden ist.",
  step1: "1. Was war falsch?",
  describe: "Beschreib es: was du erwartet hast, was angekommen ist, woran du es erkennst (10–500 Zeichen)",
  step2: "2. Beweise, dass du der Käufer bist: Signiere mit der Wallet, die bezahlt hat.",
  connectSign: "Wallet verbinden und signieren",
  step3: "3. Beweise, dass du den Artikel hast.",
  introA: "Du bekommst einen einmaligen Code und ",
  introStrong: "90 Sekunden",
  introB: ". Schreib ihn auf Papier, leg ihn neben den erhaltenen Artikel und fotografiere beides. Nur mit der Kamera, kein Hochladen: So ist der Beweis aktuell und deiner.",
};

type Step = "describe" | "signing" | "capture" | "filed" | "error";

export default function ReportForm({ order }: { order: string }) {
  const t = useLang() === "de" ? de : en;
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
      if (!res.ok) throw new Error(body.error ?? t.startFailed(res.status));

      setMessage(t.sign(wallet.name));
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
    if (!res.ok) throw new Error(body.error ?? t.cameraFailed);
    return body;
  }

  async function submitFrame(frame: { sessionId: string; imageBase64: string; mediaType: string }): Promise<FrameResult> {
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: intent!.intentId, ...frame, category, description }),
    });
    const body = await res.json();
    if (res.status === 503) return { kind: "unavailable", detail: body.error ?? t.tryAgain };
    if (!res.ok) return { kind: "judged", passed: false, reason: body.error ?? t.notFiled };
    return body.passed
      ? { kind: "judged", passed: true, reason: "" }
      : { kind: "judged", passed: false, reason: body.reason ?? t.photoFailed };
  }

  if (step === "filed") {
    return (
      <div className="notice">
        <p>
          <strong>{t.filedStrong}</strong>
          {t.filed}
        </p>
      </div>
    );
  }

  return (
    <div className="report-form">
      <fieldset disabled={step !== "describe" && step !== "error"}>
        <legend>{t.step1}</legend>
        {t.categories.map((c) => (
          <label key={c.value} className="radio">
            <input type="radio" name="category" value={c.value} checked={category === c.value} onChange={() => setCategory(c.value)} />
            <span>{c.label}</span>
          </label>
        ))}
        <label className="stacked">
          <span>{t.describe}</span>
          <textarea value={description} maxLength={500} rows={4} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </fieldset>

      {(step === "describe" || step === "error") && (
        <>
          <p className="hint">{t.step2}</p>
          <WalletButton label={t.connectSign} disabled={!ready} onConnect={signAsBuyer} onError={walletError} />
        </>
      )}

      {step === "capture" && intent && (
        <section>
          <p className="hint">{t.step3}</p>
          <CameraCapture
            facingMode="environment"
            requestChallenge={requestChallenge}
            submitFrame={submitFrame}
            onComplete={() => setStep("filed")}
            intro={
              <p>
                {t.introA}
                <strong>{t.introStrong}</strong>
                {t.introB}
              </p>
            }
          />
        </section>
      )}

      {message && <p className={step === "error" ? "notice withheld" : "hint"}>{message}</p>}
    </div>
  );
}
