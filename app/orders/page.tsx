import Link from "next/link";
import { cookies } from "next/headers";
import { Connection, PublicKey } from "@solana/web3.js";
import { getLang, getMessages } from "@/lib/i18n/server";
import { decimalText } from "@/lib/i18n/money";
import { SESSION_COOKIE, sessionWallet, signInConfigured } from "@/lib/account/session";
import { ordersForBuyer, refundOpen, type WalletOrder } from "@/lib/account/orders";
import { ordersRpcUrl } from "@/lib/checkout/checkout";
import { formatUsdc } from "@/lib/chains/solana/orders";
import { SignedIn, SignInButton } from "./SignIn";

/**
 * app/orders — "My orders": every escrow order the signed-in wallet paid for.
 *
 * Signed in means a wallet proved itself with a signature and got a cookie
 * (lib/account/session.ts). The orders come straight from the chain, filtered
 * on the buyer (lib/account/orders.ts), so they're the same on every device
 * and SigPath keeps nothing to show them. Like the order page, it shows what
 * the chain shows: status, amount and dates, never the item or the address.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return { title: `${getMessages().account.title} — SigPath`, robots: { index: false } };
}

export default async function OrdersPage() {
  const m = getMessages();
  const lang = getLang();
  const t = m.account;
  const wallet = sessionWallet(cookies().get(SESSION_COOKIE)?.value);

  let orders: WalletOrder[] | null = null;
  let unreadable = false;
  if (wallet) {
    try {
      orders = await ordersForBuyer(new Connection(ordersRpcUrl(), "confirmed"), new PublicKey(wallet));
    } catch {
      unreadable = true;
    }
  }

  const date = (unix: number) =>
    new Date(unix * 1000).toLocaleString(lang === "de" ? "de-DE" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });
  const now = Math.floor(Date.now() / 1000);

  return (
    <main className="container account">
      <h1>{t.title}</h1>
      <p className="lede">{t.lede}</p>

      {!signInConfigured() ? (
        <p className="notice withheld">{t.off}</p>
      ) : !wallet ? (
        <section className="account-signin">
          <h2>{t.signInTitle}</h2>
          <p>{t.signInText}</p>
          <SignInButton />
        </section>
      ) : (
        <>
          <SignedIn wallet={wallet} />
          {unreadable ? (
            <p className="notice withheld">{t.unreadable}</p>
          ) : !orders?.length ? (
            <p className="notice">{t.none}</p>
          ) : (
            <ul className="account-orders">
              {orders.map((o) => {
                const open = refundOpen(o, now);
                return (
                  <li key={o.address} className="listing">
                    <div className="body">
                      <p className={`order-status ${o.status}`}>{t.status[o.status]}</p>
                      <p className="meta">
                        {t.placed} {date(o.createdAt)} &middot;{" "}
                        {o.settledAt > 0 ? `${t.settled} ${date(o.settledAt)}` : `${t.deadline} ${date(o.deadline)}`}
                      </p>
                      <p>
                        <Link className={open ? "button" : "button ghost"} href={`/order/${o.address}`}>
                          {open ? t.refundOpen : t.open}
                        </Link>
                      </p>
                    </div>
                    <div className="price">{decimalText(formatUsdc(o.amount), lang)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <p className="hint" style={{ marginTop: 24 }}>
        <Link href="/privacy#sign-in">{t.privacy}</Link>
      </p>
    </main>
  );
}
