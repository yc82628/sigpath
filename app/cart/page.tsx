import PopIcon from "../components/PopIcon";
import { getMessages } from "@/lib/i18n/server";
import CartView from "./CartView";
import { quoteSigningConfigured } from "@/lib/checkout/quote";
import { AddressStore } from "@/lib/checkout/address-store";
import { MAX_CART_ORDERS } from "@/lib/checkout/checkout";

export const metadata = { title: "Your cart — SigPath" };

export default function CartPage() {
  const m = getMessages();
  return (
    <main className="container wide cart">
      <h1 className="with-icon cart-title">
        <PopIcon name="shopping-cart-simple" tone="purple" size={32} />
        {m.cart.title}
      </h1>
      <p className="lede">{m.cart.lede}</p>
      <CartView
        removeIcon={<PopIcon name="trash" tone="purple" size={18} />}
        checkoutOn={quoteSigningConfigured() && AddressStore.fromEnv() !== null}
        maxPerPayment={MAX_CART_ORDERS}
      />
    </main>
  );
}
