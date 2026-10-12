import PopIcon from "../components/PopIcon";
import CartView from "./CartView";

export const metadata = { title: "Your cart — SigPath" };

export default function CartPage() {
  return (
    <main className="container wide cart">
      <h1 className="with-icon cart-title">
        <PopIcon name="shopping-cart-simple" tone="purple" size={32} />
        Your cart
      </h1>
      <p className="lede">
        Kept in this browser only: no account, and SigPath doesn&apos;t store what&apos;s in it. Each time you open it,
        SigPath asks the marketplace for today&apos;s price.
      </p>
      <CartView removeIcon={<PopIcon name="trash" tone="purple" size={18} />} />
    </main>
  );
}
