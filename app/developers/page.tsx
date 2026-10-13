import Link from "next/link";
import { getLang } from "@/lib/i18n/server";

/**
 * app/developers — SigPath's verification API, for other apps.
 *
 * Paid per request through pay.sh (paysh/sigpath.yaml), described in
 * /openapi.json. The example response is a real one from the supplier check,
 * run against the live EU VAT register and Verisign's registry.
 */

export function generateMetadata() {
  return {
    title: getLang() === "de" ? "SigPath-API: Verkäufer, Unternehmen und Lieferanten prüfen" : "SigPath API — verify sellers, businesses and suppliers",
  };
}

/** Method, path, what it answers (English, German), price in USDC. The API's own answers stay English. */
const ENDPOINTS: [string, string, string, string, string][] = [
  [
    "GET",
    "/api/v1/seller?marketplace=ebay&handle=…",
    "Verified seller (cross-checked on Solana), the business behind it, upheld fake-product findings",
    "Verifizierter Verkäufer (auf Solana gegengeprüft), das Unternehmen dahinter, bestätigte Fälschungsbefunde",
    "0.001",
  ],
  [
    "GET",
    "/api/v1/business?vatCountry=DE&vatNumber=…",
    "A verified business by VAT number, website (?domain=) or id: status, evidence, linked accounts",
    "Ein verifiziertes Unternehmen nach USt-IdNr., Website (?domain=) oder ID: Status, Belege, verknüpfte Konten",
    "0.001",
  ],
  [
    "POST",
    "/api/v1/supplier",
    "Supplier check: EU VAT register, name match, website age, SigPath records",
    "Lieferantenprüfung: EU-USt-Register, Namensabgleich, Alter der Website, SigPaths Daten",
    "0.005",
  ],
  [
    "GET",
    "/api/check?q=…",
    "Deal check across eBay and Amazon: every listing's verdict and the best checked deal",
    "Angebotsprüfung über eBay und Amazon: das Urteil zu jedem Angebot und das beste geprüfte Angebot",
    "0.002",
  ],
];

const EXAMPLE = `{
  "summary": {
    "state": "concerns",
    "headline": "Warning signs found. Read these before ordering."
  },
  "findings": [
    { "check": "vat", "state": "good", "title": "Registered business",
      "detail": "VAT number IE••••047V is valid in the EU's VIES register (Ireland)." },
    { "check": "name", "state": "warn", "title": "Name doesn't match the register",
      "detail": "The register gives the name for this VAT number as GOOGLE IRELAND LIMITED, not \\"Cheap Phones Direct\\". Someone may be using another company's VAT number." },
    { "check": "website", "state": "bad", "title": "Website domain doesn't exist",
      "detail": "this-shop-does-not-exist-sigpath-9471.com isn't registered (checked with rdap.verisign.com)." },
    { "check": "sigpath", "state": "unknown", "title": "Not a verified business on SigPath",
      "detail": "That isn't a warning sign on its own: most businesses haven't verified with SigPath." }
  ],
  "businessProfile": null,
  "checkedAt": "2026-10-03T14:19:50.000Z"
}`;

export default function DevelopersPage() {
  const de = getLang() === "de";
  const T = (en: string, german: string) => (de ? german : en);
  return (
    <main className="container wide developers">
      <h1>{T("SigPath API", "SigPath-API")}</h1>
      <p className="lede">
        {T(
          "Verify sellers, businesses and suppliers from your own app: marketplaces, procurement and accounting tools, AI agents. Pay per request in USDC on Solana through ",
          "Prüfe Verkäufer, Unternehmen und Lieferanten aus deiner eigenen App: Marktplätze, Einkaufs- und Buchhaltungstools, KI-Agenten. Bezahlt wird pro Anfrage in USDC auf Solana über ",
        )}
        <a href="https://pay.sh" rel="noopener">
          pay.sh
        </a>
        {T(", with no account and no API key.", ", ohne Konto und ohne API-Schlüssel.")}
      </p>
      <p className="notice">
        <strong>{T("Paying never changes an answer.", "Bezahlen ändert nie eine Antwort.")}</strong>{" "}
        {T(
          "The API runs the website's own checks over the same records. A seller or business can't buy a better result, and you get exactly what a shopper would see.",
          "Die API führt dieselben Prüfungen wie die Website über dieselben Daten aus. Kein Verkäufer und kein Unternehmen kann sich ein besseres Ergebnis kaufen, und du bekommst genau das, was ein Käufer sehen würde.",
        )}
      </p>

      <h2>{T("Endpoints", "Endpunkte")}</h2>
      <div className="table-scroll">
        <table className="api-table">
          <thead>
            <tr>
              <th>{T("Request", "Anfrage")}</th>
              <th>{T("Answers", "Antwort")}</th>
              <th>USDC</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map(([method, path, what, whatDe, price]) => (
              <tr key={path}>
                <td>
                  <code>
                    <span className="method">{method}</span> {path}
                  </code>
                </td>
                <td>{de ? whatDe : what}</td>
                <td className="price">{price}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        {T("Full description for code generators and agents: ", "Vollständige Beschreibung für Code-Generatoren und Agenten: ")}
        <a href="/openapi.json">/openapi.json</a> (OpenAPI 3.1).
      </p>

      <h2>{T("How paying works", "So funktioniert das Bezahlen")}</h2>
      <ol className="agent-steps">
        <li>
          <strong>{T("Ask", "Anfragen")}</strong>
          <span>{T("Call the endpoint on SigPath's pay.sh gateway.", "Rufe den Endpunkt über SigPaths pay.sh-Gateway auf.")}</span>
        </li>
        <li>
          <strong>{T("Pay", "Bezahlen")}</strong>
          <span>{T("It answers 402 with the price; your wallet approves the USDC transfer.", "Es antwortet mit 402 und dem Preis; deine Wallet bestätigt die USDC-Überweisung.")}</span>
        </li>
        <li>
          <strong>{T("Get the answer", "Antwort erhalten")}</strong>
          <span>{T("Settled on Solana, then forwarded to SigPath. One request, one payment.", "Auf Solana abgewickelt, dann an SigPath weitergeleitet. Eine Anfrage, eine Zahlung.")}</span>
        </li>
      </ol>

      <h2>{T("Try it in the sandbox", "In der Sandbox ausprobieren")}</h2>
      <p className="hint">{T("pay.sh's test network and test USDC: nothing real is spent.", "Das Testnetz von pay.sh und Test-USDC: Es wird kein echtes Geld ausgegeben.")}</p>
      <pre className="code-block">
        <code>{`npx @solana/pay --sandbox gate api paysh/sigpath.yaml --bind 127.0.0.1:1402 --openapi ../public/openapi.json

npx @solana/pay --sandbox curl "http://127.0.0.1:1402/api/v1/seller?marketplace=ebay&handle=some_seller"

npx @solana/pay --sandbox curl -X POST http://127.0.0.1:1402/api/v1/supplier \\
  -H "Content-Type: application/json" \\
  -d '{"vatCountry":"IE","vatNumber":"6388047V","name":"Cheap Phones Direct","domain":"this-shop-does-not-exist-sigpath-9471.com"}'`}</code>
      </pre>

      <h2>{T("Example: a borrowed VAT number", "Beispiel: eine geliehene USt-IdNr.")}</h2>
      <p className="hint">
        {T(
          "A real response from the supplier check, against the live EU VAT register and the .com registry.",
          "Eine echte Antwort der Lieferantenprüfung, gegen das EU-USt-Register und die .com-Registry. Die API antwortet auf Englisch.",
        )}
      </p>
      <pre className="code-block">
        <code>{EXAMPLE}</code>
      </pre>

      <h2>{T("What the answers mean", "Was die Antworten bedeuten")}</h2>
      <ul className="evidence">
        <li className="info">
          <strong>{T("Verified seller / business", "Verifizierter Verkäufer / Unternehmen")}</strong>{" "}
          {T("vouches for ", "bürgt dafür, ")}
          <em>{T("who runs an account", "wer ein Konto führt")}</em>
          {T(", not for any item. Every answer carries a ", ", nicht für einen Artikel. Jede Antwort hat ein Feld ")}
          <code>meaning</code>
          {T(" field saying so, for your users.", ", das das für deine Nutzer sagt.")}
        </li>
        <li className="info">
          <strong>{T("Unknown is not bad.", "Unbekannt ist nicht schlecht.")}</strong>{" "}
          {T(
            "Checks that couldn't run say why (a register that doesn't publish names, a registry without dates). Most businesses haven't verified with SigPath.",
            "Prüfungen, die nicht laufen konnten, sagen warum (ein Register ohne Namen, eine Registry ohne Daten). Die meisten Unternehmen haben sich nicht bei SigPath verifiziert.",
          )}
        </li>
        <li className="info">
          <strong>{T("Nothing you send is stored.", "Nichts, was du sendest, wird gespeichert.")}</strong>{" "}
          {T(
            "Supplier details go only to the public registers they're checked against.",
            "Lieferantenangaben gehen nur an die öffentlichen Register, gegen die sie geprüft werden.",
          )}
        </li>
      </ul>
      <p className="hint" style={{ marginTop: 20 }}>
        {T("Building an AI shopping agent? See ", "Du baust einen KI-Einkaufsagenten? Siehe ")}
        <Link href="/agents">{T("For AI agents", "Für KI-Agenten")}</Link>.
      </p>
    </main>
  );
}
