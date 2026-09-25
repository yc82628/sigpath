import Link from "next/link";
import { verifyQuote } from "@/lib/checkout/quote";
import { eurUsdRate, toUsdcBaseUnits } from "@/lib/checkout/fx";
import { checkoutWindowSecs } from "@/lib/checkout/checkout";
import { AddressStore, RETENTION_MAX_SECONDS } from "@/lib/checkout/address-store";
import { formatUsdc, MAX_AMOUNT } from "@/lib/chains/solana/orders";
import { formatMoney } from "@/lib/marketplace/types";
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
  const usdc = toUsdcBaseUnits(l.amount, l.currency, rate);
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
        <p className="price-line">
          {formatMoney({ amount: l.amount, currency: l.currency })} including shipping
          {usdc !== null && <> &rarr; <strong>{formatUsdc(usdc)}</strong></>}
        </p>
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

          <CheckoutForm quote={token} usdcDisplay={formatUsdc(usdc)} />
          <p className="hint">
            Devnet only: set Phantom to Devnet first, and pay with devnet USDC from
            faucet.circle.com.
          </p>
        </>
      )}
    </main>
  );
}
