import Link from "next/link";
import PopIcon from "../components/PopIcon";
import { getLang } from "@/lib/i18n/server";
import SupplierCheck from "./SupplierCheck";

/**
 * app/suppliers — check a supplier before ordering in bulk (B2B). In English and German.
 */

export function generateMetadata() {
  return { title: getLang() === "de" ? "Lieferanten prüfen — SigPath" : "Check a supplier — SigPath" };
}

export default function SuppliersPage() {
  const de = getLang() === "de";
  const T = (en: string, german: string) => (de ? german : en);
  return (
    <main className="container">
      <h1>{T("Check a supplier", "Lieferanten prüfen")}</h1>
      <p className="lede">
        {T(
          "Buying stock? Check a supplier is who they say they are before you pay.",
          "Du kaufst Ware ein? Prüfe vor dem Bezahlen, ob ein Lieferant ist, wer er vorgibt zu sein.",
        )}
      </p>

      <section className="guarantees">
        <h2>{T("What it checks", "Was geprüft wird")}</h2>
        <ul className="icon-list">
          <li className="with-icon">
            <PopIcon name="buildings" tone="purple" size={24} />
            <span>
              <strong>{T("Registered business:", "Eingetragenes Unternehmen:")}</strong>{" "}
              {T(
                "the VAT number against the EU's VIES register, and whether the name they gave you matches the register's.",
                "die USt-IdNr. im VIES-Register der EU, und ob der genannte Name mit dem im Register übereinstimmt.",
              )}
            </span>
          </li>
          <li className="with-icon">
            <PopIcon name="calendar-dots" tone="blue" size={24} />
            <span>
              <strong>{T("Website age:", "Alter der Website:")}</strong>{" "}
              {T(
                "when the domain was registered, from its registry. Scam shops are typically weeks old.",
                "wann die Domain registriert wurde, laut ihrer Registry. Betrugsshops sind meist nur wenige Wochen alt.",
              )}
            </span>
          </li>
          <li className="with-icon">
            <PopIcon name="database" tone="green" size={24} />
            <span>
              <strong>{T("SigPath's records:", "SigPaths Daten:")}</strong>{" "}
              {T(
                "verified sellers and businesses, upheld fake-product reports, and details that belong to a ",
                "verifizierte Verkäufer und Unternehmen, bestätigte Fälschungsmeldungen und Angaben, die zu einem ",
              )}
              <em>{T("different", "anderen")}</em>
              {T(" verified business.", " verifizierten Unternehmen gehören.")}
            </span>
          </li>
        </ul>
      </section>

      <SupplierCheck />

      <p className="hint" style={{ marginTop: 24 }}>
        {T("Are you a supplier? ", "Du bist Lieferant? ")}
        <Link href="/seller/business">{T("Verify your business", "Verifiziere dein Unternehmen")}</Link>
        {T(" so buyers' checks find you.", ", damit die Prüfungen von Käufern dich finden.")}
      </p>
    </main>
  );
}
