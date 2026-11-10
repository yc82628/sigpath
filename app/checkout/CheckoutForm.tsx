"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import WalletButton from "../components/WalletButton";
import { DEVNET, WalletError, waitForPayment } from "../components/wallet";
import { shortAddress, useWallet, useWalletErrorText, useWalletFunds } from "../components/WalletProvider";
import { useCheckText, useLang, useMessages } from "../components/I18n";
import { usdc } from "@/lib/i18n/money";
import { firstExpiry, readQuote } from "@/lib/checkout/quote-public";
import { useMounted } from "../components/useMounted";

/**
 * The delivery form and the wallet step.
 *
 * The address goes to the server once, in the same request that builds the
 * transaction, and is stored encrypted before the transaction comes back. It is
 * never kept in the browser beyond this form's state: no localStorage, no
 * cookie. Closing the tab is enough to forget it on this side.
 *
 * The wallet is the site's (WalletProvider): connected here or in the header,
 * the form shows its balance straight away and says before Pay, not after,
 * when it is short. The checkout still checks again on Pay; this is only so
 * nobody fills in an address for a payment their wallet can't make.
 *
 * AFTER THE WALLET SENDS
 * The wallet hands back the transaction's signature, and the form follows it
 * on SigPath's own network (lib/checkout/payment-status.ts) until it is paid,
 * refused by the network, or past the point where it could still land. So a
 * wallet set to Mainnet, or an approval left too long, ends in "nothing was
 * charged, press Pay again" instead of an endless "confirming". And when a
 * wallet reports an error, the form first looks whether the payment went out
 * anyway (some wallets time out after sending), so nobody pays twice.
 *
 * THE PRICE
 * A quote lasts thirty minutes. The form says until when, and once it has run
 * out offers the current price in place, so the address typed in stays.
 */

const FIELDS: { key: string; required: boolean; autoComplete: string }[] = [
  { key: "name", required: true, autoComplete: "name" },
  { key: "line1", required: true, autoComplete: "address-line1" },
  { key: "line2", required: false, autoComplete: "address-line2" },
  { key: "postcode", required: true, autoComplete: "postal-code" },
  { key: "city", required: true, autoComplete: "address-level2" },
  { key: "country", required: true, autoComplete: "country" },
];

type Phase = "idle" | "building" | "signing" | "confirming" | "checking" | "error";

export default function CheckoutForm({
  quote,
  quotes,
  onPaid,
  onRefresh,
  usdcDisplay,
  totalUsdc,
  localDisplay,
  moonPay = false,
}: {
  /** One listing (the search's pay button)… */
  quote?: string;
  /** …or several from the cart: one transaction, one escrow order each. */
  quotes?: string[];
  /** For the cart: called with the orders once the payment is confirmed (or sent, if confirmation is slow). */
  onPaid?: (orders: { order: string; source: string; id: string }[], confirmed: boolean, wallet?: string) => void;
  /** For the cart: fetch current prices for every item; resolves to a reason if it couldn't. */
  onRefresh?: () => Promise<string | null>;
  usdcDisplay: string;
  /** The total in USDC base units (the invoice's), to compare with the wallet's balance before Pay. */
  totalUsdc?: string;
  /** The same total in the listing's currency, for reference (e.g. "145,82 €"). */
  localDisplay?: string;
  /** Whether to offer MoonPay when the wallet is short (see MOONPAY_ENABLED). */
  moonPay?: boolean;
}) {
  const router = useRouter();
  const m = useMessages();
  const lang = useLang();
  const tc = useCheckText();
  const describe = useWalletErrorText();
  const { wallet } = useWallet();
  // The wallet as it is now, for a step that started with another (an account switched mid-payment).
  const current = useRef(wallet);
  current.current = wallet;
  const funds = useWalletFunds(wallet?.address);
  const [address, setAddress] = useState<Record<string, string>>({ country: "DE" });
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  /** An order whose payment couldn't be told apart from a slow one: link to it rather than pay again. */
  const [unclearOrder, setUnclearOrder] = useState<string | null>(null);
  /** How much more USDC the connected wallet needs, as the checkout said on Pay. */
  const [shortfall, setShortfall] = useState<number | null>(null);
  const [topUpNote, setTopUpNote] = useState("");

  // The price's time: read from the quotes themselves, ticking so "run out" shows without a reload.
  const tokens = quotes ?? (quote ? [quote] : []);
  const tokenKey = tokens.join(",");
  const expiresAt = firstExpiry(tokens);
  const [now, setNow] = useState(() => Date.now());
  const [serverExpired, setServerExpired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  // New prices: whatever the server said about the old ones no longer holds.
  useEffect(() => {
    setServerExpired(false);
    setNow(Date.now());
  }, [tokenKey]);
  // The shopper's clock, read in the browser only (useMounted): the server can't know it.
  const mounted = useMounted();
  const expired = serverExpired || (mounted && expiresAt !== null && now / 1000 > expiresAt);

  // Another account is another balance: what the checkout said about the last one no longer holds.
  useEffect(() => {
    setShortfall(null);
    setTopUpNote("");
  }, [wallet?.address]);

  // Known before Pay: the balance against the invoice's total, and SOL for the fees.
  const orderCount = quotes?.length ?? 1;
  const shortBy = funds.status === "ok" && totalUsdc ? BigInt(totalUsdc) - funds.usdc : 0n;
  const needSol = funds.status === "ok" && funds.lamports < funds.minSolLamports * orderCount ? (funds.minSolLamports * orderCount) / 1e9 : 0;
  const short = shortfall ?? (shortBy > 0n ? Number(shortBy) / 1e6 : null);

  async function buyWithMoonPay() {
    if (!wallet || short === null) return;
    // Opened now, inside the click, so a popup blocker lets it through; filled once the link is signed.
    const tab = window.open("", "_blank");
    setTopUpNote("Opening MoonPay…");
    try {
      const qs = new URLSearchParams({ wallet: wallet.address, usdc: String(short), back: window.location.href });
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

  /** The current price, in place: the cart asks its own items again; one listing gets a fresh quote and the page follows it. */
  async function refreshPrice() {
    setRefreshing(true);
    setPhase("idle");
    setMessage("");
    try {
      if (onRefresh) {
        const why = await onRefresh();
        if (why) throw new Error(why);
      } else if (quote) {
        const q = readQuote(quote);
        if (!q) throw new Error(m.cart.checkFailed);
        const res = await fetch("/api/cart/requote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ source: q.source, id: q.id, title: q.title }] }),
        });
        const body = await res.json().catch(() => ({}));
        const fresh = body.quotes?.[0];
        if (!res.ok || !fresh?.ok || typeof fresh.token !== "string") throw new Error(fresh?.reason ?? body.error ?? m.cart.checkFailed);
        // The server draws the new invoice; this form, and the address in it, stay as they are.
        router.replace(`/checkout?quote=${encodeURIComponent(fresh.token)}`);
      }
    } catch (err) {
      setPhase("error");
      setMessage(tc(err instanceof Error ? err.message : m.cart.checkFailed));
    } finally {
      setRefreshing(false);
    }
  }

  function connected() {
    setPhase("idle");
    setMessage("");
  }

  function walletError(text: string) {
    setPhase("error");
    setMessage(text);
  }

  function fail(text: string) {
    setPhase("error");
    setMessage(text);
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet || expired) return;
    const payingAs = wallet.address;

    setPhase("building");
    setMessage(m.checkout.preparingOrder);
    setShortfall(null);
    setTopUpNote("");
    setUnclearOrder(null);
    let order: string;
    let transaction: string;
    let validUntil: number | null = null;
    let cartOrders: { order: string; source: string; id: string }[] = [];
    try {
      const cart = quotes !== undefined;
      const res = await fetch(cart ? "/api/checkout/cart" : "/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cart ? { quotes, buyer: payingAs, address } : { quote, buyer: payingAs, address }),
      });
      const body = await res.json();
      if (res.status === 402) {
        if (typeof body.shortfallUsdc === "number") setShortfall(body.shortfallUsdc);
        funds.refresh();
      }
      if (body.code === "quote_expired") setServerExpired(true);
      if (!res.ok) throw new Error(body.error ?? `Checkout failed (${res.status}).`);
      cartOrders = cart ? body.orders : [];
      order = cart ? body.orders[0].order : body.order;
      transaction = body.transaction;
      validUntil = typeof body.validUntil === "number" ? body.validUntil : null;
    } catch (err) {
      return fail(describe(err));
    }

    // The transaction was built for the account the form showed. Switched since? Nothing is sent.
    if (current.current?.address !== payingAs) return fail(m.checkout.switched);

    setPhase("signing");
    setMessage(m.checkout.approve(wallet.name));
    let signature: string | null;
    try {
      signature = await wallet.signAndSend(transaction);
    } catch (err) {
      // A no in the wallet, or a wallet that can't send: certainly nothing was paid. The stored
      // address is deleted by the sweep once the order has failed to appear for fifteen minutes.
      if (err instanceof WalletError && (err.code === "refused" || err.code === "cant-send")) {
        return fail(m.checkout.notSent(describe(err)));
      }
      // Anything else may have come after the payment left: look before letting them pay again.
      setPhase("checking");
      setMessage(m.checkout.checking);
      const outcome = await waitForPayment(order, null, validUntil);
      if (outcome.state === "paid") return finish(order, cartOrders, true, null, payingAs);
      if (outcome.state === "pending") {
        setUnclearOrder(order);
        return fail(m.checkout.unclear);
      }
      return fail(m.checkout.notSent(describe(err)));
    }

    setPhase("confirming");
    setMessage(m.checkout.sent);
    const outcome = await waitForPayment(order, signature, validUntil);
    if (outcome.state === "paid") return finish(order, cartOrders, true, signature, payingAs);
    if (outcome.state === "failed") return fail(m.checkout.failedOnChain(outcome.reason ?? "rejected"));
    if (outcome.state === "expired") return fail(m.checkout.expired(DEVNET));
    // Still confirming after two minutes: the order page keeps watching.
    finish(order, cartOrders, false, signature, payingAs);
  }

  function finish(order: string, cartOrders: { order: string; source: string; id: string }[], confirmed: boolean, signature: string | null, payer: string) {
    if (onPaid) return onPaid(cartOrders, confirmed, payer);
    const qs = confirmed ? "" : `?pending=1${signature ? `&tx=${signature}` : ""}`;
    router.push(`/order/${order}${qs}`);
  }

  const busy = phase === "building" || phase === "signing" || phase === "confirming" || phase === "checking";
  const until = mounted && expiresAt ? new Date(expiresAt * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) : null;

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

      {expired && !busy ? (
        <div className="notice withheld" role="status">
          <p>{m.checkout.priceExpired}</p>
          <button type="button" className="primary" onClick={refreshPrice} disabled={refreshing}>
            {refreshing ? m.checkout.refreshing : m.checkout.refreshPrice}
          </button>
        </div>
      ) : (
        until && <p className="hint">{m.checkout.priceUntil(until)}</p>
      )}

      {!wallet ? (
        <WalletButton label={m.checkout.connect} onConnect={connected} onError={walletError} />
      ) : (
        <>
          <p className="hint">
            {m.checkout.payingFrom} {wallet.name} <code>{shortAddress(wallet.address)}</code>
            {" · "}
            {m.wallet.balance}{" "}
            {funds.status === "ok"
              ? usdc(funds.usdc.toString(), lang)
              : funds.status === "error"
                ? m.wallet.balanceUnavailable
                : m.wallet.checking}{" "}
            <button type="button" className="link" onClick={funds.refresh} disabled={funds.status === "loading"}>
              {m.wallet.checkAgain}
            </button>
          </p>
          {DEVNET && <p className="hint">{m.checkout.devnetPay}</p>}
          {(shortBy > 0n || needSol > 0) && shortfall === null && (
            <p className="notice withheld" role="status">
              {shortBy > 0n && m.wallet.short(usdc(shortBy.toString(), lang))}
              {shortBy > 0n && needSol > 0 && " "}
              {needSol > 0 && m.wallet.needSol(needSol.toLocaleString(lang, { maximumFractionDigits: 3 }))}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy || expired}>
            {busy ? m.checkout.working : m.checkout.payButton(`${usdcDisplay}${localDisplay ? ` (${localDisplay})` : ""}`)}
          </button>
        </>
      )}

      {message && (
        <p className={phase === "error" ? "notice withheld" : "notice"} role={phase === "error" ? "alert" : "status"}>
          {message}
          {unclearOrder && (
            <>
              {" "}
              <Link href={`/order/${unclearOrder}?pending=1`}>{m.checkout.openOrder} →</Link>
            </>
          )}
        </p>
      )}

      {short !== null && wallet && (
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
