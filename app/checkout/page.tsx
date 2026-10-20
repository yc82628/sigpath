import Link from "next/link";
import { verifyQuote } from "@/lib/checkout/quote";
import { checkoutWindowSecs, invoiceFor } from "@/lib/checkout/checkout";
import { AddressStore, RETENTION_MAX_SECONDS } from "@/lib/checkout/address-store";
import { moonPayAvailable } from "@/lib/onramp/moonpay";
import { DecisionLog } from "@/lib/reports/reports";
import { getLang } from "@/lib/i18n/server";
import { MESSAGES } from "@/lib/i18n/messages";
import { translateCheck } from "@/lib/i18n/checks";
import CheckoutForm from "./CheckoutForm";
import Invoice from "./Invoice";
import { usdc } from "@/lib/i18n/money";

/**
 * app/checkout/page.tsx — pay for one listing with USDC.
 *
 * Everything shown about the item comes from the SIGNED quote the search page
 * issued; nothing on this page can be changed to alter what is charged. The
 * invoice is computed by the same code that builds the payment (invoiceFor),
 * and the wallet shows the final amount before the shopper approves.
 */

export const dynamic = "force-dynamic";

export default async function CheckoutPage({ searchParams }: { searchParams: { quote?: string } }) {
  const lang = getLang();
  const m = MESSAGES[lang];
  const token = searchParams.quote ?? "";
  const q = verifyQuote(token);

  if (!q.ok || !AddressStore.fromEnv()) {
    const why =
      !AddressStore.fromEnv() || (!q.ok && q.reason === "not_configured")
        ? lang === "de"
          ? "Die USDC-Kasse ist auf diesem Server nicht eingerichtet."
          : "USDC checkout is not configured on this server."
        : !q.ok && q.reason === "expired"
          ? lang === "de"
            ? "Dieser Preis ist abgelaufen: Preise ändern sich, daher gelten Angebote dreißig Minuten."
            : "This price has expired — prices move, so quotes last thirty minutes."
          : lang === "de"
            ? "Dieser Kassenlink ist ungültig."
            : "This checkout link isn't valid.";
    return (
      <main className="container checkout-page">
        <h1>{m.checkout.title}</h1>
        <p className="notice withheld">{why}</p>
        <p>
          <Link href="/search">{m.alerts.back}</Link>
        </p>
      </main>
    );
  }

  const invoice = await invoiceFor([token], { upheldReports: await DecisionLog.fromEnv().upheldCounts() });
  const days = (secs: number) => m.checkout.days(Math.round(secs / 86400));

  return (
    <main className="container checkout-page">
      <h1>{m.listing.pay}</h1>

      {!invoice.ok ? (
        <p className="notice withheld">{translateCheck(invoice.error, lang)}</p>
      ) : (
        <>
          <Invoice data={invoice} />

          <section className="guarantees">
            <h2>{m.checkout.moneyTitle}</h2>
            <ul>
              <li>{m.checkout.money1}</li>
              <li>{m.checkout.money2(days(checkoutWindowSecs()))}</li>
              <li>{m.checkout.money3}</li>
            </ul>
            <p className="hint">{m.checkout.addressNote(days(RETENTION_MAX_SECONDS))}</p>
          </section>

          <CheckoutForm quote={token} usdcDisplay={usdc(invoice.totalUsdc, lang)} totalUsdc={invoice.totalUsdc} moonPay={moonPayAvailable() !== null} />
        </>
      )}
    </main>
  );
}
