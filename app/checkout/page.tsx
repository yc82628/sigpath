import Link from "next/link";
import { verifyQuote } from "@/lib/checkout/quote";
import { eurUsdRate, toUsdcBaseUnits } from "@/lib/checkout/fx";
import { formatFeeRate, withServiceFee } from "@/lib/checkout/fee";
import { checkoutWindowSecs } from "@/lib/checkout/checkout";
import { AddressStore, RETENTION_MAX_SECONDS } from "@/lib/checkout/address-store";
import { formatUsdc, MAX_AMOUNT } from "@/lib/chains/solana/orders";
import { formatMoney } from "@/lib/marketplace/types";
import { moonPayAvailable } from "@/lib/onramp/moonpay";
import CheckoutForm from "./CheckoutForm";

/**
 * app/checkout/page.tsx — pay for one listing with USDC.
 *
 * Everything shown about the item comes from the SIGNED quote the search page
 * issued; nothing on this page can be changed to alter what is charged. The
 * price shown here is a preview — the server re-derives it from the same quote
 * when the transaction is built, and the wallet shows the final amount before
 * the shopper approves.
 */

export const dynamic = "force-dynamic";

function days(secs: number) {
  const d = Math.round(secs / 86400);
  return d === 1 ? "1 day" : `${d} days`;
}

export default async function CheckoutPage({ searchParams }: { searchParams: { quote?: string } }) {
  const token = searchParams.quote ?? "";
  const q = verifyQuote(token);

  if (!q.ok || !AddressStore.fromEnv()) {
    const why =
      !AddressStore.fromEnv() || (!q.ok && q.reason === "not_configured")
        ? "USDC checkout is not configured on this server."
        : !q.ok && q.reason === "expired"
          ? "This price has expired — prices move, so quotes last thirty minutes."
          : "This checkout link isn't valid.";
    return (
      <main className="container">
        <h1>Checkout</h1>
        <p className="notice withheld">{why}</p>
        <p>
          <Link href="/search">Back to search</Link>
        </p>
      </main>
    );
  }

  const l = q.listing;
  const rate = l.currency.toUpperCase() === "USD" ? null : await eurUsdRate();
  const itemUsdc = toUsdcBaseUnits(l.amount, l.currency, rate);
  // The same rule the server applies when it builds the payment: the rate signed into the quote.
  const feeBps = l.feeBps ?? 0;
  const priced = itemUsdc === null ? null : withServiceFee(itemUsdc, feeBps);
  const usdc = priced?.total ?? null;
  // The same fee in the listing's own currency, for reference: rounded up to the cent like the USDC one.
  const feeMinor = Math.ceil((l.amount * feeBps) / 10_000);
  const local = (minor: number) => formatMoney({ amount: minor, currency: l.currency });
  const windowSecs = checkoutWindowSecs();

  return (
    <main className="container">
      <h1>Pay with USDC</h1>

      <section className="checkout-item">
        <h2>
          <a href={l.url} target="_blank" rel="noopener noreferrer">
            {l.title}
          </a>
        </h2>
        <p className="meta">{l.source}</p>
        <p className="price-line">{local(l.amount)} including shipping</p>
        {priced && (
          <table className="price-breakdown">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Item</span>
                </th>
                <th scope="col">{l.currency.toUpperCase()}</th>
                <th scope="col">USDC</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Item, including shipping</th>
                <td>{local(l.amount)}</td>
                <td>{formatUsdc(priced.price)}</td>
              </tr>
              {feeBps > 0 && (
                <tr>
                  <th scope="row">SigPath service fee ({formatFeeRate(feeBps)})</th>
                  <td>{local(feeMinor)}</td>
                  <td>{formatUsdc(priced.fee)}</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{local(l.amount + feeMinor)}</td>
                <td>{formatUsdc(priced.total)}</td>
              </tr>
            </tfoot>
          </table>
        )}
        {priced && (
          <p className="hint">
            You pay the USDC amount.{" "}
            {l.currency.toUpperCase() === "USD" ? "" : `The ${l.currency.toUpperCase()} column is for reference, at the rate below.`}
          </p>
        )}
        {feeBps > 0 && (
          <p className="hint">
            The service fee is held in escrow with the price, and refunded with it if your order isn&apos;t fulfilled.
          </p>
        )}
        {rate && (
          <p className="hint">
            At {rate.display} USD per EUR ({rate.source}). USDC tracks the US dollar.
          </p>
        )}
      </section>

      {usdc === null ? (
        <p className="notice withheld">This can&apos;t be priced in USDC right now.</p>
      ) : usdc > MAX_AMOUNT ? (
        <p className="notice withheld">This is over the {formatUsdc(MAX_AMOUNT)} per-order limit.</p>
      ) : (
        <>
          <section className="guarantees">
            <h2>What happens to your money</h2>
            <ul>
              <li>
                It is held by the SigPath escrow program on Solana — not by SigPath, and not by
                anyone holding a key.
              </li>
              <li>
                SigPath is paid only when it marks your order fulfilled, and only within{" "}
                {days(windowSecs)}.
              </li>
              <li>
                If that doesn&apos;t happen in time, you — or anyone — can trigger the refund, and it
                can only go back to your wallet.
              </li>
            </ul>
            <p className="hint">
              The program can&apos;t see a parcel arrive: it guarantees your refund if SigPath does
              nothing, not that the item matches its listing.
            </p>
          </section>

          <section className="privacy">
            <h2>Your address</h2>
            <p className="hint">
              SigPath buys this item for you, so it needs to know where to send it. The address is
              stored encrypted, used only for this delivery, and <strong>deleted as soon as the order
              is fulfilled or refunded</strong> — and in any case within{" "}
              {days(RETENTION_MAX_SECONDS)}. No email, no account, nothing else is collected.
            </p>
          </section>

          <CheckoutForm
            quote={token}
            usdcDisplay={formatUsdc(usdc)}
            localDisplay={local(l.amount + feeMinor)}
            moonPay={moonPayAvailable() !== null}
          />
          <p className="hint">
            Devnet only: pay from any Solana wallet (Phantom, Solflare, Backpack…) set to Devnet,
            with devnet USDC from faucet.circle.com.
          </p>
        </>
      )}
    </main>
  );
}
