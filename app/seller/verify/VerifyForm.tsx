"use client";

import { useState } from "react";
import CameraCapture, { type CaptureChallenge, type FrameResult } from "../../components/CameraCapture";
import WalletButton from "../../components/WalletButton";
import { walletErrorMessage, type ConnectedWallet } from "../../components/wallet";

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
  { value: "ebay", label: "eBay", hint: "The item number — the 12-digit number on the listing page." },
  { value: "etsy", label: "Etsy", hint: "The listing id — the number in the listing's URL after /listing/." },
  { value: "stub", label: "Demo marketplace", hint: "Demo only: type handle:listing text, e.g. my_shop:Genuine boots SIGPATH-ABCD-EFGH" },
] as const;

export default function VerifyForm({ explorerBase, demoEnabled }: { explorerBase: string; demoEnabled: boolean }) {
  const [step, setStep] = useState<Step>("connect");
  const [message, setMessage] = useState("");
  const [claim, setClaim] = useState<{ claimToken: string; code: string } | null>(null);
  const [source, setSource] = useState<string>("ebay");
  const [listingId, setListingId] = useState("");
  const [proven, setProven] = useState<{ provenToken: string; sellerKey: string; message: string } | null>(null);
  const [signature, setSignature] = useState("");
  const [badge, setBadge] = useState<{ sellerKey: string; attestation: string; mint: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);

  async function post(path: string, body: unknown) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status}).`);
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
      setMessage(walletErrorMessage(err));
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
      setMessage(walletErrorMessage(err));
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
    if (res.status === 503) return { kind: "unavailable", detail: body.error ?? "try again" };
    if (!res.ok) return { kind: "judged", passed: false, reason: body.error ?? "The badge could not be issued." };
    if (!body.passed) return { kind: "judged", passed: false, reason: body.reason ?? "The photo didn't pass." };
    setBadge(body);
    return { kind: "judged", passed: true, reason: "" };
  }

  if (step === "done" && badge) {
    return (
      <div className="notice">
        <p>
          <strong>Verified.</strong> <code>{badge.sellerKey}</code> now shows a verified-seller badge on
          SigPath until {new Date(badge.expiresAt * 1000).toISOString().slice(0, 10)}. The token is in
          your wallet and can&apos;t be transferred.
        </p>
        <p className="hint">
          <a href={`${explorerBase}/address/${badge.attestation}?cluster=devnet`} target="_blank" rel="noreferrer">
            The attestation on Solana
          </a>{" "}
          ·{" "}
          <a href={`${explorerBase}/address/${badge.mint}?cluster=devnet`} target="_blank" rel="noreferrer">
            The token
          </a>
        </p>
        <p className="hint">You can remove the code from your listing now.</p>
      </div>
    );
  }

  const sourceHint = SOURCES.find((s) => s.value === source)?.hint;

  return (
    <div className="report-form">
      {(step === "connect" || (step === "error" && !claim)) && (
        <>
          <p className="hint">1. Connect the wallet the badge will live in. It can never be moved out of it.</p>
          <WalletButton label="Connect wallet" disabled={busy} onConnect={connect} onError={walletError} />
        </>
      )}

      {claim && (step === "listing" || step === "sign" || step === "capture") && (
        <fieldset disabled={step !== "listing" || busy}>
          <legend>2. Prove the account is yours</legend>
          <p>
            Add this code to the title or description of one of your <strong>live</strong> listings, and
            save it:
          </p>
          <p className="code-display">
            <code>{claim.code}</code>
          </p>
          <label className="stacked">
            <span>Marketplace</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.filter((s) => demoEnabled || s.value !== "stub").map((s) => (
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
              Check the listing
            </button>
          )}
        </fieldset>
      )}

      {proven && step === "sign" && (
        <section>
          <p className="hint">
            3. Found it: the listing belongs to <code>{proven.sellerKey}</code>. Sign with your wallet to
            claim that account — a signature over text, nothing moves.
          </p>
          <button type="button" className="primary" disabled={busy} onClick={sign}>
            Sign in {wallet?.name ?? "your wallet"}
          </button>
        </section>
      )}

      {step === "capture" && (
        <section>
          <p className="hint">4. Show you&apos;re a real person.</p>
          <CameraCapture
            facingMode="user"
            requestChallenge={requestChallenge}
            submitFrame={submitFrame}
            onComplete={() => setStep("done")}
            intro={
              <p>
                You&apos;ll get a one-time code and <strong>90 seconds</strong>. Write it on paper and hold
                it next to your face. The photo is checked and thrown away — SigPath keeps no picture of you
                and no face data.
              </p>
            }
          />
        </section>
      )}

      {message && <p className="notice withheld">{message}</p>}
    </div>
  );
}
