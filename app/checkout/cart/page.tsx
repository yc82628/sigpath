import Link from "next/link";
import { quoteSigningConfigured } from "@/lib/checkout/quote";
import { AddressStore, RETENTION_MAX_SECONDS } from "@/lib/checkout/address-store";
import { checkoutWindowSecs, MAX_CART_ORDERS } from "@/lib/checkout/checkout";
import { moonPayAvailable } from "@/lib/onramp/moonpay";
import { getMessages } from "@/lib/i18n/server";
import CartCheckout from "./CartCheckout";

/**
 * app/checkout/cart — pay for the cart's SigPath-checked items in one go.
 *
 * One delivery address, one wallet approval, and one escrow order per item
 * (lib/checkout/checkout.ts, prepareCartCheckout): each is fulfilled, refunded
 * and reported on its own. Items whose quote has run out are checked again
 * first (lib/cart/requote.ts); the rest of the cart is bought on eBay. The
 * invoice shows every price and conversion before anything is paid.
 */

export const metadata = { title: "Checkout — SigPath" };
export const dynamic = "force-dynamic";

export default function CartCheckoutPage() {
  const m = getMessages();
  const days = (secs: number) => m.checkout.days(Math.round(secs / 86400));
  const on = quoteSigningConfigured() && AddressStore.fromEnv() !== null;
  if (!on) {
    return (
      <main className="container">
        <h1>{m.checkout.title}</h1>
        <p className="notice withheld">{m.checkout.off}</p>
        <p>
          <Link href="/cart">{m.checkout.backToCart}</Link>
        </p>
      </main>
    );
  }
  return (
    <main className="container">
      <h1>{m.checkout.title}</h1>
      <p className="lede">{m.checkout.lede}</p>
      <CartCheckout max={MAX_CART_ORDERS} moonPay={moonPayAvailable() !== null} />
      <section className="guarantees">
        <h2>{m.checkout.moneyTitle}</h2>
        <ul>
          <li>{m.checkout.money1}</li>
          <li>{m.checkout.money2(days(checkoutWindowSecs()))}</li>
          <li>{m.checkout.money3}</li>
        </ul>
        <p className="hint">{m.checkout.addressNote(days(RETENTION_MAX_SECONDS))}</p>
      </section>
    </main>
  );
}
