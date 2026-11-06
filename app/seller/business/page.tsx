import Link from "next/link";
import BusinessForm from "./BusinessForm";
import { getLang } from "@/lib/i18n/server";
import { planPrices } from "@/lib/sellers/plan";

/**
 * app/seller/business — the verified-business tier, on top of verified accounts.
 * Says what it checks and what it doesn't before asking for anything. In
 * English and German.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return { title: getLang() === "de" ? "Dein Unternehmen verifizieren — SigPath" : "Verify your business — SigPath" };
}

export default function BusinessPage() {
  const de = getLang() === "de";
  const T = (en: string, german: string) => (de ? german : en);
  const prices = planPrices();
  const eur = (cents: number) => new Intl.NumberFormat(de ? "de-DE" : "en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
  return (
    <main className="container">
      <h1>{T("Verify your business", "Dein Unternehmen verifizieren")}</h1>
      <p className="lede">
        {T(
          "Already a verified seller? Show shoppers the registered business behind your accounts, on eBay, with a ",
          "Schon verifizierter Verkäufer? Zeig Käufern das eingetragene Unternehmen hinter deinen Konten, auf eBay, mit einem Abzeichen ",
        )}
        <span className="verified business">{T("✓ Verified business", "✓ Verifiziertes Unternehmen")}</span>
        {T(" badge and a public profile.", " und einem öffentlichen Profil.")}
      </p>

      <section className="guarantees">
        <h2>{T("What it checks, and what it doesn't", "Was geprüft wird und was nicht")}</h2>
        <ul>
          <li>
            <strong>{T("Your accounts belong together:", "Deine Konten gehören zusammen:")}</strong>{" "}
            {T(
              "every marketplace account you verified with the same wallet is linked. Nothing is guessed.",
              "Jedes Marktplatzkonto, das du mit derselben Wallet verifiziert hast, wird verknüpft. Nichts wird geraten.",
            )}
          </li>
          <li>
            <strong>{T("You're a registered business:", "Du bist ein eingetragenes Unternehmen:")}</strong>{" "}
            {T(
              "your EU VAT number, checked live against the EU's VIES register. The name shown comes from the register.",
              "deine USt-IdNr., live im VIES-Register der EU geprüft. Der angezeigte Name stammt aus dem Register.",
            )}
          </li>
          <li>
            <strong>{T("Your website (optional):", "Deine Website (optional):")}</strong>{" "}
            {T("a one-time record in your domain's DNS.", "ein einmaliger Eintrag im DNS deiner Domain.")}
          </li>
          <li>
            {T("It vouches for ", "Es bürgt dafür, ")}
            <em>{T("who runs the accounts", "wer die Konten führt")}</em>
            {T(
              ", not for any item. One upheld fake-product report against any linked account suspends it for all of them.",
              ", nicht für einen Artikel. Eine einzige bestätigte Fälschungsmeldung gegen ein verknüpftes Konto setzt es für alle aus.",
            )}
          </li>
        </ul>
      </section>

      <section className="guarantees">
        <h2>{T("What it costs", "Was es kostet")}</h2>
        <ul>
          <li>
            <strong>{T("Monthly:", "Monatlich:")}</strong> {eur(prices.month)}
            {prices.opening && <span className="hint"> {T(`(opening offer, then ${eur(prices.regular.month)})`, `(Eröffnungsangebot, danach ${eur(prices.regular.month)})`)}</span>}
          </li>
          <li>
            <strong>{T("Yearly:", "Jährlich:")}</strong> {eur(prices.year)} <span className="hint">{T("(10% off twelve months)", "(10 % günstiger als zwölf Monate)")}</span>
          </li>
          <li>
            {T(
              "Paid in USDC, no automatic renewal. It pays for the checks, the badge and your profile, never for a place in search: results are ordered by the deal, the same for everyone. Your verified-seller badge stays free.",
              "Bezahlt in USDC, ohne automatische Verlängerung. Bezahlt werden die Prüfungen, das Abzeichen und dein Profil, nie ein Platz in der Suche: Ergebnisse sind nach dem Angebot sortiert, für alle gleich. Dein Abzeichen als verifizierter Verkäufer bleibt kostenlos.",
            )}
          </li>
        </ul>
      </section>

      <BusinessForm />

      <p className="hint" style={{ marginTop: 24 }}>
        {T("Not verified yet? ", "Noch nicht verifiziert? ")}
        <Link href="/seller/verify">{T("Become a verified seller", "Werde zuerst verifizierter Verkäufer")}</Link>
        {T(" first.", ".")}
      </p>
    </main>
  );
}
