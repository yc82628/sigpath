"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import WalletButton from "../components/WalletButton";
import { DEVNET, waitForOrder, walletErrorMessage, type ConnectedWallet } from "../components/wallet";
import { useMessages } from "../components/I18n";

/**
 * The delivery form and the wallet step.
 *
 * The address goes to the server once, in the same request that builds the
 * transaction, and is stored encrypted before the transaction comes back. It is
 * never kept in the browser beyond this form's state: no localStorage, no
 * cookie. Closing the tab is enough to forget it on this side.
 */

const FIELDS: { key: string; required: boolean; autoComplete: string }[] = [
  { key: "name", required: true, autoComplete: "name" },
  { key: "line1", required: true, autoComplete: "address-line1" },
  { key: "line2", required: false, autoComplete: "address-line2" },
  { key: "postcode", required: true, autoComplete: "postal-code" },
  { key: "city", required: true, autoComplete: "address-level2" },
  { key: "country", required: true, autoComplete: "country" },
];

type Phase = "idle" | "building" | "signing" | "confirming" | "error";

export default function CheckoutForm({
  quote,
  quotes,
  onPaid,
  usdcDisplay,
  localDisplay,
  moonPay = false,
}: {
  /** One listing (the search's pay button)… */
  quote?: string;
  /** …or several from the cart: one transaction, one escrow order each. */
  quotes?: string[];
  /** For the cart: called with the orders once the payment is confirmed (or sent, if confirmation is slow). */
  onPaid?: (orders: { order: string; source: string; id: string }[], confirmed: boolean, wallet?: string) => void;
  usdcDisplay: string;
  /** The same total in the listing's currency, for reference (e.g. "145,82 €"). */
  localDisplay?: string;
  /** Whether to offer MoonPay when the wallet is short (see MOONPAY_ENABLED). */
  moonPay?: boolean;
}) {
  const router = useRouter();
  const m = useMessages();
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
    setMessage(m.checkout.preparingOrder);
    setShortfall(null);
    setTopUpNote("");
    let order: string;
    let transaction: string;
    let cartOrders: { order: string; source: string; id: string }[] = [];
    try {
      const cart = quotes !== undefined;
      const res = await fetch(cart ? "/api/checkout/cart" : "/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cart ? { quotes, buyer: wallet.address, address } : { quote, buyer: wallet.address, address }),
      });
      const body = await res.json();
      if (res.status === 402 && typeof body.shortfallUsdc === "number") setShortfall(body.shortfallUsdc);
      if (!res.ok) throw new Error(body.error ?? `Checkout failed (${res.status}).`);
      cartOrders = cart ? body.orders : [];
      order = cart ? body.orders[0].order : body.order;
      transaction = body.transaction;
    } catch (err) {
      setPhase("error");
      setMessage(walletErrorMessage(err));
      return;
    }

    setPhase("signing");
    setMessage(m.checkout.approve(wallet.name));
    try {
      await wallet.signAndSend(transaction);
    } catch (err) {
      // Nothing was paid. The stored address is deleted by the sweep once the
      // order has failed to appear for fifteen minutes.
      setPhase("error");
      setMessage(m.checkout.notSent(walletErrorMessage(err)));
      return;
    }

    setPhase("confirming");
    setMessage(m.checkout.sent);
    const seen = await waitForOrder(order, (s) => s.found === true);
    if (onPaid) return onPaid(cartOrders, seen, wallet.address);
    // Go to the order page either way: it reads the chain directly, and is the
    // right place to watch a slow confirmation too.
    router.push(`/order/${order}${seen ? "" : "?pending=1"}`);
  }

  const busy = phase === "building" || phase === "signing" || phase === "confirming";

  return (
    <form className="checkout-form" onSubmit={pay}>
      <fieldset disabled={busy}>
        <legend>{m.checkout.address}</legend>
        {FIELDS.map((f) => (
          <label key={f.key}>
            <span>{m.checkout.fields[f.key]}</span>
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
        <WalletButton label={m.checkout.connect} onConnect={connected} onError={walletError} />
      ) : (
        <>
          <p className="hint">
            {m.checkout.payingFrom} {wallet.name} <code>{wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}</code>
          </p>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? m.checkout.working : m.checkout.payButton(`${usdcDisplay}${localDisplay ? ` (${localDisplay})` : ""}`)}
          </button>
        </>
      )}

      {message && <p className={phase === "error" ? "notice withheld" : "notice"}>{message}</p>}

      {shortfall !== null && wallet && (
        <section className="top-up">
          <h3>{m.checkout.topUp}</h3>
          {moonPay ? (
            <>
              <p className="hint">
                {m.checkout.moonpay}
              </p>
              <button type="button" className="primary" onClick={buyWithMoonPay}>
                {m.checkout.moonpayButton}
              </button>
            </>
          ) : (
            <p className="hint">
              {m.checkout.addUsdc}
            </p>
          )}
          {DEVNET && (
            <p className="hint">
              {m.checkout.faucet}{" "}
              <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer">
                faucet.circle.com
              </a>
            </p>
          )}
          {topUpNote && <p className="hint">{topUpNote}</p>}
        </section>
      )}
    </form>
  );
}
