"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getPhantom, txFromBase64, waitForOrder, walletErrorMessage } from "../components/phantom";

/**
 * The delivery form and the wallet step.
 *
 * The address goes to the server once, in the same request that builds the
 * transaction, and is stored encrypted before the transaction comes back. It is
 * never kept in the browser beyond this form's state: no localStorage, no
 * cookie. Closing the tab is enough to forget it on this side.
 */

const FIELDS: { key: string; label: string; required: boolean; autoComplete: string }[] = [
  { key: "name", label: "Full name", required: true, autoComplete: "name" },
  { key: "line1", label: "Street and number", required: true, autoComplete: "address-line1" },
  { key: "line2", label: "Address line 2 (optional)", required: false, autoComplete: "address-line2" },
  { key: "postcode", label: "Postcode", required: true, autoComplete: "postal-code" },
  { key: "city", label: "City", required: true, autoComplete: "address-level2" },
  { key: "country", label: "Country code (e.g. DE)", required: true, autoComplete: "country" },
];

type Phase = "idle" | "building" | "signing" | "confirming" | "error";

export default function CheckoutForm({ quote, usdcDisplay }: { quote: string; usdcDisplay: string }) {
  const router = useRouter();
  const [address, setAddress] = useState<Record<string, string>>({ country: "DE" });
  const [wallet, setWallet] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  async function connect() {
    const phantom = getPhantom();
    if (!phantom) {
      setPhase("error");
      setMessage("Phantom wallet not found. Install it from phantom.app, set it to Devnet, and reload.");
      return;
    }
    try {
      const { publicKey } = await phantom.connect();
      setWallet(publicKey.toBase58());
      setPhase("idle");
      setMessage("");
    } catch (err) {
      setPhase("error");
      setMessage(`Wallet connection refused: ${walletErrorMessage(err)}`);
    }
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    const phantom = getPhantom();
    if (!phantom || !wallet) return;

    setPhase("building");
    setMessage("Preparing your order…");
    let order: string;
    let transaction: string;
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote, buyer: wallet, address }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Checkout failed (${res.status}).`);
      order = body.order;
      transaction = body.transaction;
    } catch (err) {
      setPhase("error");
      setMessage(walletErrorMessage(err));
      return;
    }

    setPhase("signing");
    setMessage("Approve the payment in Phantom. Check the amount it shows before you approve.");
    try {
      await phantom.signAndSendTransaction(txFromBase64(transaction));
    } catch (err) {
      // Nothing was paid. The stored address is deleted by the sweep once the
      // order has failed to appear for fifteen minutes.
      setPhase("error");
      setMessage(`Payment not sent: ${walletErrorMessage(err)}`);
      return;
    }

    setPhase("confirming");
    setMessage("Payment sent. Waiting for the network to confirm…");
    const seen = await waitForOrder(order, (s) => s.found === true);
    // Go to the order page either way: it reads the chain directly, and is the
    // right place to watch a slow confirmation too.
    router.push(`/order/${order}${seen ? "" : "?pending=1"}`);
  }

  const busy = phase === "building" || phase === "signing" || phase === "confirming";

  return (
    <form className="checkout-form" onSubmit={pay}>
      <fieldset disabled={busy}>
        <legend>Delivery address</legend>
        {FIELDS.map((f) => (
          <label key={f.key}>
            <span>{f.label}</span>
            <input
              name={f.key}
              required={f.required}
              autoComplete={f.autoComplete}
              maxLength={f.key === "country" ? 2 : 200}
              value={address[f.key] ?? ""}
              onChange={(e) => setAddress({ ...address, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </fieldset>

      {!wallet ? (
        <button type="button" className="primary" onClick={connect}>
          Connect Phantom
        </button>
      ) : (
        <>
          <p className="hint">
            Paying from <code>{wallet.slice(0, 4)}…{wallet.slice(-4)}</code>
          </p>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Working…" : `Pay ${usdcDisplay}`}
          </button>
        </>
      )}

      {message && <p className={phase === "error" ? "notice withheld" : "notice"}>{message}</p>}
    </form>
  );
}
