import Link from "next/link";
import { quoteSigningConfigured } from "@/lib/checkout/quote";
import { AddressStore, RETENTION_MAX_SECONDS } from "@/lib/checkout/address-store";
import { checkoutWindowSecs, MAX_CART_ORDERS } from "@/lib/checkout/checkout";
import { moonPayAvailable } from "@/lib/onramp/moonpay";
import CartCheckout from "./CartCheckout";

/**
 * app/checkout/cart — pay for the cart's SigPath-checked items in one go.
 *
 * One delivery address, one wallet approval, and one escrow order per item
 * (lib/checkout/checkout.ts, prepareCartCheckout): each is fulfilled, refunded
 * and reported on its own. Items whose quote has run out are checked again
 * first (lib/cart/requote.ts); the rest of the cart is bought on eBay.
 */

export const metadata = { title: "Checkout — SigPath" };
export const dynamic = "force-dynamic";

const days = (secs: number) => {
  const d = Math.round(secs / 86400);
  return d === 1 ? "1 day" : `${d} days`;
};

export default function CartCheckoutPage() {
  const on = quoteSigningConfigured() && AddressStore.fromEnv() !== null;
  if (!on) {
    return (
      <main className="container">
        <h1>Checkout</h1>
        <p className="notice withheld">USDC checkout isn&apos;t switched on here yet. Buy each item on eBay from your cart.</p>
        <p>
          <Link href="/cart">Back to your cart</Link>
        </p>
      </main>
    );
  }
  return (
    <main className="container">
      <h1>Checkout</h1>
      <p className="lede">Your SigPath-checked items, paid in USDC with one approval.</p>
      <CartCheckout max={MAX_CART_ORDERS} moonPay={moonPayAvailable() !== null} />
      <section className="guarantees">
        <h2>What happens to your money</h2>
        <ul>
          <li>Each item is its own escrow order on Solana, held by the program, not by SigPath.</li>
          <li>SigPath is paid for an item only when it marks that order fulfilled, within {days(checkoutWindowSecs())}.</li>
          <li>If it doesn&apos;t, you (or anyone) can trigger that item&apos;s refund, straight back to your wallet.</li>
        </ul>
        <p className="hint">
          Your address is stored encrypted, used only for these deliveries, and deleted once each order is settled, within{" "}
          {days(RETENTION_MAX_SECONDS)} at most. Devnet only: use a wallet set to Devnet and test USDC.
        </p>
      </section>
    </main>
  );
}
