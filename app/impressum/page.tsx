import Link from "next/link";
import { operator } from "@/lib/legal/site";

/**
 * app/impressum/page.tsx — the legal notice German law asks of a commercial
 * site (§ 5 DDG). The details come from the deployment's settings
 * (lib/legal/site.ts), so a service address can be used and nothing personal
 * sits in the code.
 */

export const metadata = { title: "Impressum — SigPath" };
export const dynamic = "force-dynamic";

export default function ImpressumPage() {
  const op = operator();
  return (
    <main className="container legal">
      <h1>Impressum</h1>
      <p className="hint">Legal notice under § 5 DDG (Digitale-Dienste-Gesetz).</p>

      {op ? (
        <>
          <h2>Angaben gemäß § 5 DDG</h2>
          <p>
            {op.name}
            {op.address.map((line) => (
              <span key={line}>
                <br />
                {line}
              </span>
            ))}
          </p>

          <h2>Kontakt</h2>
          <p>
            E-Mail: <a href={`mailto:${op.email}`}>{op.email}</a>
            {op.phone && (
              <>
                <br />
                Telefon: {op.phone}
              </>
            )}
          </p>

          {op.vatId && (
            <>
              <h2>Umsatzsteuer-ID</h2>
              <p>Umsatzsteuer-Identifikationsnummer gemäß § 27 a UStG: {op.vatId}</p>
            </>
          )}
        </>
      ) : (
        <p className="notice">The operator&apos;s details are being set up.</p>
      )}

      <p className="hint">
        How SigPath handles data: <Link href="/privacy">Privacy policy (Datenschutzerklärung)</Link>.
      </p>
    </main>
  );
}
