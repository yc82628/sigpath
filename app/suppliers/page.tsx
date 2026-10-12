import Link from "next/link";
import PopIcon from "../components/PopIcon";
import SupplierCheck from "./SupplierCheck";

/**
 * app/suppliers — check a supplier before ordering in bulk (B2B).
 */

export const metadata = { title: "Check a supplier — SigPath" };

export default function SuppliersPage() {
  return (
    <main className="container">
      <h1>Check a supplier</h1>
      <p className="lede">
        Buying stock? Check a supplier is who they say they are before you pay.
      </p>

      <section className="guarantees">
        <h2>What it checks</h2>
        <ul className="icon-list">
          <li className="with-icon">
            <PopIcon name="buildings" tone="purple" size={24} />
            <span>
              <strong>Registered business:</strong> the VAT number against the EU&apos;s VIES register, and whether the name
              they gave you matches the register&apos;s.
            </span>
          </li>
          <li className="with-icon">
            <PopIcon name="calendar-dots" tone="blue" size={24} />
            <span>
              <strong>Website age:</strong> when the domain was registered, from its registry. Scam shops are typically weeks
              old.
            </span>
          </li>
          <li className="with-icon">
            <PopIcon name="database" tone="green" size={24} />
            <span>
              <strong>SigPath&apos;s records:</strong> verified sellers and businesses, upheld fake-product reports, and details
              that belong to a <em>different</em> verified business.
            </span>
          </li>
        </ul>
      </section>

      <SupplierCheck />

      <p className="hint" style={{ marginTop: 24 }}>
        Are you a supplier? <Link href="/seller/business">Verify your business</Link> so buyers&apos; checks find you.
      </p>
    </main>
  );
}
