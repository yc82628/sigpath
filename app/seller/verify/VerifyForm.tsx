"use client";

import { useState } from "react";
import CameraCapture, { type CaptureChallenge, type FrameResult } from "../../components/CameraCapture";
import WalletButton from "../../components/WalletButton";
import type { ConnectedWallet } from "../../components/wallet";
import { useWalletChange, useWalletErrorText } from "../../components/WalletProvider";
import { useLang } from "../../components/I18n";

/**
 * Claim the verified-seller badge, in four steps the seller can see:
 *
 *   1. connect the wallet the badge will live in — get a one-time code
 *   2. put the code in one of your live listings, then point SigPath at it
 *   3. sign a message with the wallet (nothing moves)
 *   4. a live photo: a handwritten code, checked and discarded
 *
 * Nothing is kept in the browser beyond this page's state.
 */

type Step = "connect" | "listing" | "sign" | "capture" | "done" | "error";

const SOURCES = [
  {
    value: "ebay",
    label: "eBay",
    hint: "The item number — the 12-digit number on the listing page.",
    hintDe: "Die Artikelnummer: die 12-stellige Nummer auf der Angebotsseite.",
  },
  {
    value: "etsy",
    label: "Etsy",
    hint: "The listing id — the number in the listing's URL after /listing/.",
    hintDe: "Die Angebots-ID: die Nummer in der Adresse des Angebots nach /listing/.",
  },
  {
    value: "stub",
    label: "Demo marketplace",
    hint: "Demo only: type handle:listing text, e.g. my_shop:Genuine boots SIGPATH-ABCD-EFGH",
    hintDe: "Nur Demo: gib Name:Angebotstext ein, z. B. my_shop:Genuine boots SIGPATH-ABCD-EFGH",
  },
] as const;

export default function VerifyForm({ explorerBase, marketplaces }: { explorerBase: string; marketplaces: readonly string[] }) {
  const de = useLang() === "de";
  const T = (en: string, german: string) => (de ? german : en);
  // Only the marketplaces this site can actually read (lib/sellers/claim.ts claimMarketplaces).
  const offered = SOURCES.filter((s) => marketplaces.includes(s.value));
  const realNames = offered.filter((s) => s.value !== "stub").map((s) => s.label);
  const [step, setStep] = useState<Step>("connect");
  const [message, setMessage] = useState("");
  const [claim, setClaim] = useState<{ claimToken: string; code: string } | null>(null);
  const [source, setSource] = useState<string>(offered[0]?.value ?? "ebay");
  const [listingId, setListingId] = useState("");
  const [proven, setProven] = useState<{ provenToken: string; sellerKey: string; message: string } | null>(null);
  const [signature, setSignature] = useState("");
  const [badge, setBadge] = useState<{ sellerKey: string; attestation: string; mint: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const describe = useWalletErrorText();

  // The code and the signature belong to one wallet. If the person switches or
  // disconnects before the badge is issued, start again with the new one.
  useWalletChange(step === "done" ? null : wallet?.address, () => {
    setWallet(null);
    setClaim(null);
    setProven(null);
    setSignature("");
    setStep("connect");
    setMessage(T(
      "Your wallet changed, so verification starts again with the wallet now connected.",
      "Deine Wallet hat gewechselt, daher beginnt die Verifizierung mit der jetzt verbundenen Wallet von vorn.",
    ));
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? T(`Request failed (${res.status}).`, `Anfrage fehlgeschlagen (${res.status}).`));
    return data;
  }

  function walletError(text: string) {
    setStep("error");
    setMessage(text);
  }

  async function connect(w: ConnectedWallet) {
    try {
      setBusy(true);
      setWallet(w);
      setClaim(await post("/api/sellers/claim/start", { wallet: w.address }));
      setStep("listing");
      setMessage("");
    } catch (err) {
      setStep("error");
      setMessage(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function checkListing() {
    try {
      setBusy(true);
      setMessage("");
      setProven(await post("/api/sellers/claim/prove", { claimToken: claim!.claimToken, source, listingId }));
      setStep("sign");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!wallet || !proven) return;
    try {
      setBusy(true);
      setSignature(await wallet.signMessage(proven.message));
      setStep("capture");
      setMessage("");
    } catch (err) {
      setMessage(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function requestChallenge(): Promise<CaptureChallenge> {
    return post("/api/sellers/claim/challenge", { provenToken: proven!.provenToken, signature });
  }

  async function submitFrame(frame: { sessionId: string; imageBase64: string; mediaType: string }): Promise<FrameResult> {
    const res = await fetch("/api/sellers/claim/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provenToken: proven!.provenToken, ...frame }),
    });
    const body = await res.json();
    if (res.status === 503) return { kind: "unavailable", detail: body.error ?? T("try again", "versuche es erneut") };
    if (!res.ok) return { kind: "judged", passed: false, reason: body.error ?? T("The badge could not be issued.", "Das Abzeichen konnte nicht ausgestellt werden.") };
    if (!body.passed) return { kind: "judged", passed: false, reason: body.reason ?? T("The photo didn't pass.", "Das Foto hat die Prüfung nicht bestanden.") };
    setBadge(body);
    return { kind: "judged", passed: true, reason: "" };
  }

  if (step === "done" && badge) {
    return (
      <div className="notice">
        <p>
          <strong>{T("Verified.", "Verifiziert.")}</strong> <code>{badge.sellerKey}</code>{" "}
          {T("now shows a verified-seller badge on SigPath until ", "zeigt jetzt auf SigPath das Abzeichen „Verifizierter Verkäufer“ bis ")}
          {new Date(badge.expiresAt * 1000).toISOString().slice(0, 10)}.{" "}
          {T("The token is in your wallet and can't be transferred.", "Das Token liegt in deiner Wallet und kann nicht übertragen werden.")}
        </p>
        <p className="hint">
          <a href={`${explorerBase}/address/${badge.attestation}?cluster=devnet`} target="_blank" rel="noreferrer">
            {T("The attestation on Solana", "Die Attestierung auf Solana")}
          </a>{" "}
          ·{" "}
          <a href={`${explorerBase}/address/${badge.mint}?cluster=devnet`} target="_blank" rel="noreferrer">
            {T("The token", "Das Token")}
          </a>
        </p>
        <p className="hint">{T("You can remove the code from your listing now.", "Du kannst den Code jetzt aus deinem Angebot entfernen.")}</p>
      </div>
    );
  }

  const chosen = SOURCES.find((s) => s.value === source);
  const sourceHint = de ? chosen?.hintDe : chosen?.hint;

  return (
    <div className="report-form">
      {(step === "connect" || (step === "error" && !claim)) && (
        <>
          <p className="hint">
            {T("1. Connect the wallet the badge will live in. It can never be moved out of it.", "1. Verbinde die Wallet, in der das Abzeichen liegen soll. Es kann sie nie verlassen.")}
          </p>
          <WalletButton label={T("Connect wallet", "Wallet verbinden")} disabled={busy} onConnect={connect} onError={walletError} />
          <p className="hint">
            {realNames.length ? T(`Works with your ${realNames.join(" or ")} listings. `, `Funktioniert mit deinen Angeboten auf ${realNames.join(" oder ")}. `) : ""}
            {T("Amazon sellers: coming soon.", "Amazon-Verkäufer: demnächst.")}
          </p>
        </>
      )}

      {claim && (step === "listing" || step === "sign" || step === "capture") && (
        <fieldset disabled={step !== "listing" || busy}>
          <legend>{T("2. Prove the account is yours", "2. Weise nach, dass das Konto dir gehört")}</legend>
          <p>
            {T("Add this code to the title or description of one of your ", "Füge diesen Code in Titel oder Beschreibung eines deiner ")}
            <strong>{T("live", "laufenden")}</strong>
            {T(" listings, and save it:", " Angebote ein und speichere es:")}
          </p>
          <p className="code-display">
            <code>{claim.code}</code>
          </p>
          <label className="stacked">
            <span>{T("Marketplace", "Marktplatz")}</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {offered.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="stacked">
            <span>{sourceHint}</span>
            <input value={listingId} maxLength={200} onChange={(e) => setListingId(e.target.value)} />
          </label>
          {step === "listing" && (
            <button type="button" className="primary" disabled={busy || !listingId.trim()} onClick={checkListing}>
              {T("Check the listing", "Angebot prüfen")}
            </button>
          )}
        </fieldset>
      )}

      {proven && step === "sign" && (
        <section>
          <p className="hint">
            {T("3. Found it: the listing belongs to ", "3. Gefunden: Das Angebot gehört zu ")}
            <code>{proven.sellerKey}</code>
            {T(
              ". Sign with your wallet to claim that account — a signature over text, nothing moves.",
              ". Signiere mit deiner Wallet, um dieses Konto zu beanspruchen: eine Signatur über Text, es wird nichts bewegt.",
            )}
          </p>
          <button type="button" className="primary" disabled={busy} onClick={sign}>
            {T(`Sign in ${wallet?.name ?? "your wallet"}`, `In ${wallet?.name ?? "deiner Wallet"} signieren`)}
          </button>
        </section>
      )}

      {step === "capture" && (
        <section>
          <p className="hint">{T("4. Show you're a real person.", "4. Zeig, dass du ein echter Mensch bist.")}</p>
          <CameraCapture
            facingMode="user"
            requestChallenge={requestChallenge}
            submitFrame={submitFrame}
            onComplete={() => setStep("done")}
            intro={
              <p>
                {T("You'll get a one-time code and ", "Du bekommst einen einmaligen Code und ")}
                <strong>{T("90 seconds", "90 Sekunden")}</strong>
                {T(
                  ". Write it on paper and hold it next to your face. The photo is checked and thrown away — SigPath keeps no picture of you and no face data.",
                  ". Schreib ihn auf Papier und halte ihn neben dein Gesicht. Das Foto wird geprüft und verworfen: SigPath speichert kein Bild von dir und keine Gesichtsdaten.",
                )}
              </p>
            }
          />
        </section>
      )}

      {message && <p className="notice withheld">{message}</p>}
    </div>
  );
}
