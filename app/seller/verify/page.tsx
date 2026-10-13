import Link from "next/link";
import PopIcon from "../../components/PopIcon";
import { claimMarketplaces } from "@/lib/sellers/claim";
import { getLang } from "@/lib/i18n/server";
import VerifyForm from "./VerifyForm";

/**
 * app/seller/verify/page.tsx — sellers claim the verified-seller badge.
 *
 * Says up front what the badge is and is not, because a badge that promises
 * more than it checks is worse than no badge. In English and German.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return { title: getLang() === "de" ? "Verifizierter Verkäufer werden — SigPath" : "Become a verified seller — SigPath" };
}

const NAMES: Record<string, string> = { ebay: "eBay", etsy: "Etsy" };

export default function VerifyPage() {
  const de = getLang() === "de";
  const T = (en: string, german: string) => (de ? german : en);
  const marketplaces = claimMarketplaces();
  const real = marketplaces.filter((m) => m !== "stub").map((m) => NAMES[m]);
  return (
    <main className="container">
      <h1>{T("Become a verified seller", "Verifizierter Verkäufer werden")}</h1>
      <p className="lede">
        {real.length ? T(`Sell on ${real.join(" or ")}? `, `Du verkaufst auf ${real.join(" oder ")}? `) : ""}
        {T("Prove the account is yours and earn a ", "Weise nach, dass das Konto dir gehört, und erhalte das Abzeichen ")}
        <strong>{T("Verified seller", "Verifizierter Verkäufer")}</strong>
        {T(" badge on every SigPath search.", " in jeder SigPath-Suche.")}
      </p>

      <p className="hint">
        {T("A registered business? ", "Ein eingetragenes Unternehmen? ")}
        <Link href="/seller/business">{T("Verify your business", "Verifiziere auch dein Unternehmen")}</Link>
        {T(" too.", ".")}
      </p>

      <section className="guarantees">
        <h2>{T("What it checks, and what it doesn't", "Was geprüft wird und was nicht")}</h2>
        <ul className="icon-list">
          <li className="with-icon">
            <PopIcon name="key" tone="purple" size={24} />
            <span>
              <strong>{T("You control the account:", "Du kontrollierst das Konto:")}</strong>{" "}
              {T(
                "you put a one-time code in one of your listings, and SigPath reads it back through the marketplace's own API.",
                "Du setzt einen einmaligen Code in eines deiner Angebote, und SigPath liest ihn über die API des Marktplatzes aus.",
              )}
            </span>
          </li>
          <li className="with-icon">
            <PopIcon name="wallet" tone="blue" size={24} />
            <span>
              <strong>{T("You hold the wallet:", "Dir gehört die Wallet:")}</strong>{" "}
              {T("you sign a message with it. The badge is a token in that wallet that ", "Du signierst damit eine Nachricht. Das Abzeichen ist ein Token in dieser Wallet, das ")}
              <strong>{T("can't be transferred or sold", "weder übertragen noch verkauft werden kann")}</strong>.
            </span>
          </li>
          <li className="with-icon">
            <PopIcon name="user-focus" tone="green" size={24} />
            <span>
              <strong>{T("A real person is behind it:", "Ein echter Mensch steht dahinter:")}</strong>{" "}
              {T(
                "a live photo with a handwritten code, checked and discarded. No picture or face data is kept.",
                "ein Live-Foto mit einem handgeschriebenen Code, geprüft und verworfen. Es werden keine Bilder oder Gesichtsdaten gespeichert.",
              )}
            </span>
          </li>
          <li className="with-icon">
            <PopIcon name="prohibit" tone="purple" size={24} />
            <span>
              {T("It is ", "Es wird ")}
              <strong>{T("revoked", "entzogen")}</strong>
              {T(
                " if a buyer's fake-product report against the account is upheld — and an account with an upheld report can't be verified at all. The badge lasts a year.",
                ", wenn eine Fälschungsmeldung eines Käufers gegen das Konto bestätigt wird, und ein Konto mit einer bestätigten Meldung kann gar nicht verifiziert werden. Das Abzeichen gilt ein Jahr.",
              )}
            </span>
          </li>
          <li className="with-icon">
            <PopIcon name="info" tone="blue" size={24} />
            <span>
              {T("It does ", "Es bürgt ")}
              <strong>{T("not", "nicht")}</strong>
              {T(
                " vouch for any particular item, and it can't stop someone opening a new account. What it does is make “verified” visibly different from “no track record”.",
                " für einen bestimmten Artikel, und es kann niemanden daran hindern, ein neues Konto zu eröffnen. Es macht „verifiziert“ sichtbar anders als „keine Vorgeschichte“.",
              )}
            </span>
          </li>
        </ul>
      </section>

      {marketplaces.length ? (
        <VerifyForm explorerBase="https://explorer.solana.com" marketplaces={marketplaces} />
      ) : (
        <p className="notice">{T("Seller verification isn't switched on for this site yet.", "Die Verkäuferverifizierung ist auf dieser Website noch nicht eingeschaltet.")}</p>
      )}

      <p className="hint" style={{ marginTop: 24 }}>
        <Link href="/search">{T("Back to search", "Zurück zur Suche")}</Link>
      </p>
    </main>
  );
}
