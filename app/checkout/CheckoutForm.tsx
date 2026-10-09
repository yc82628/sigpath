"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import WalletButton from "../components/WalletButton";
import { DEVNET, waitForOrder, walletErrorMessage, type ConnectedWallet } from "../components/wallet";

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

export default function CheckoutForm({
  quote,
  usdcDisplay,
  localDisplay,
  moonPay = false,
}: {
  quote: string;
  usdcDisplay: string;
  /** The same total in the listing's currency, for reference (e.g. "145,82 €"). */
  localDisplay?: string;
  /** Whether to offer MoonPay when the wallet is short (see MOONPAY_ENABLED). */
  moonPay?: boolean;
}) {
  const router = useRouter();
  const [address, setAddress] = useState<Record<string, string>>({ country: "DE" });
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  /** How much more USDC the connected wallet needs, when it's short. */
  const [shortfall, setShortfall] = useState<number | null>(null);
  const [topUpNote, setTopUpNote] = useState("");

  async function buyWithMoonPay() {
    if (!wallet || shortfall === null) return;
    // Opened now, inside the click, so a popup blocker lets it through; filled once the link is signed.
    const tab = window.open("", "_blank");
    setTopUpNote("Opening MoonPay…");
    try {
      const qs = new URLSearchParams({ wallet: wallet.address, usdc: String(shortfall), back: window.location.href });
      const res = await fetch(`/api/onramp/moonpay?${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "MoonPay isn't available right now.");
      if (tab) tab.location.href = body.url;
      else window.location.href = body.url;
      setTopUpNote(
        body.test
          ? "MoonPay opened in test mode: no real money moves. When your USDC arrives, press Pay again."
          : "When MoonPay has delivered your USDC to this wallet, press Pay again.",
      );
    } catch (err) {
      tab?.close();
      setTopUpNote(err instanceof Error ? err.message : "MoonPay isn't available right now.");
    }
  }

  function connected(w: ConnectedWallet) {
    setWallet(w);
    setPhase("idle");
    setMessage("");
  }

  function walletError(text: string) {
    setPhase("error");
    setMessage(text);
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet) return;

    setPhase("building");
    setMessage("Preparing your order…");
    setShortfall(null);
    setTopUpNote("");
    let order: string;
    let transaction: string;
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote, buyer: wallet.address, address }),
      });
      const body = await res.json();
      if (res.status === 402 && typeof body.shortfallUsdc === "number") setShortfall(body.shortfallUsdc);
      if (!res.ok) throw new Error(body.error ?? `Checkout failed (${res.status}).`);
      order = body.order;
      transaction = body.transaction;
    } catch (err) {
      setPhase("error");
      setMessage(walletErrorMessage(err));
      return;
    }

    setPhase("signing");
    setMessage(`Approve the payment in ${wallet.name}. Check the amount it shows before you approve.`);
    try {
      await wallet.signAndSend(transaction);
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
        <WalletButton label="Connect wallet" onConnect={connected} onError={walletError} />
      ) : (
        <>
          <p className="hint">
            Paying from {wallet.name} <code>{wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}</code>
          </p>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Working…" : `Pay ${usdcDisplay}${localDisplay ? ` (${localDisplay})` : ""}`}
          </button>
        </>
      )}

      {message && <p className={phase === "error" ? "notice withheld" : "notice"}>{message}</p>}

      {shortfall !== null && wallet && (
        <section className="top-up">
          <h3>Top up your wallet</h3>
          {moonPay ? (
            <>
              <p className="hint">
                Buy USDC with a card or a SEPA transfer through MoonPay. It goes straight to this wallet
                ({wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}); SigPath never sees your payment details.
              </p>
              <button type="button" className="primary" onClick={buyWithMoonPay}>
                Buy USDC with MoonPay
              </button>
            </>
          ) : (
            <p className="hint">
              Add USDC to this wallet ({wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}), then press Pay again.
            </p>
          )}
          {DEVNET && (
            <p className="hint">
              This shop runs on Solana devnet: free test USDC comes from{" "}
              <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer">
                faucet.circle.com
              </a>{" "}
              (choose USDC, Solana Devnet).{moonPay && " MoonPay opens in its test mode here."}
            </p>
          )}
          {topUpNote && <p className="hint">{topUpNote}</p>}
        </section>
      )}
    </form>
  );
}
