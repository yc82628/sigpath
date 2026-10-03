import Link from "next/link";

/**
 * app/developers — SigPath's verification API, for other apps.
 *
 * Paid per request through pay.sh (paysh/sigpath.yaml), described in
 * /openapi.json. The example response is a real one from the supplier check,
 * run against the live EU VAT register and Verisign's registry.
 */

export const metadata = { title: "SigPath API — verify sellers, businesses and suppliers" };

const ENDPOINTS: [string, string, string, string][] = [
  ["GET", "/api/v1/seller?marketplace=ebay&handle=…", "Verified seller (cross-checked on Solana), the business behind it, upheld fake-product findings", "0.001"],
  ["GET", "/api/v1/business?vatCountry=DE&vatNumber=…", "A verified business by VAT number, website (?domain=) or id: status, evidence, linked accounts", "0.001"],
  ["POST", "/api/v1/supplier", "Supplier check: EU VAT register, name match, website age, SigPath records", "0.005"],
  ["GET", "/api/check?q=…", "Deal check across eBay, Amazon and Etsy: every listing's verdict and the best checked deal", "0.002"],
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
  return (
    <main className="container wide developers">
      <h1>SigPath API</h1>
      <p className="lede">
        Verify sellers, businesses and suppliers from your own app: marketplaces, procurement and accounting tools, AI
        agents. Pay per request in USDC on Solana through <a href="https://pay.sh" rel="noopener">pay.sh</a>, with no account
        and no API key.
      </p>
      <p className="notice">
        <strong>Paying never changes an answer.</strong> The API runs the website&apos;s own checks over the same records.
        A seller or business can&apos;t buy a better result, and you get exactly what a shopper would see.
      </p>

      <h2>Endpoints</h2>
      <div className="table-scroll">
        <table className="api-table">
          <thead>
            <tr>
              <th>Request</th>
              <th>Answers</th>
              <th>USDC</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map(([method, path, what, price]) => (
              <tr key={path}>
                <td>
                  <code>
                    <span className="method">{method}</span> {path}
                  </code>
                </td>
                <td>{what}</td>
                <td className="price">{price}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Full description for code generators and agents: <a href="/openapi.json">/openapi.json</a> (OpenAPI 3.1).
      </p>

      <h2>How paying works</h2>
      <ol className="agent-steps">
        <li>
          <strong>Ask</strong>
          <span>Call the endpoint on SigPath&apos;s pay.sh gateway.</span>
        </li>
        <li>
          <strong>Pay</strong>
          <span>It answers 402 with the price; your wallet approves the USDC transfer.</span>
        </li>
        <li>
          <strong>Get the answer</strong>
          <span>Settled on Solana, then forwarded to SigPath. One request, one payment.</span>
        </li>
      </ol>

      <h2>Try it in the sandbox</h2>
      <p className="hint">pay.sh&apos;s test network and test USDC: nothing real is spent.</p>
      <pre className="code-block">
        <code>{`npx @solana/pay --sandbox gate api paysh/sigpath.yaml --bind 127.0.0.1:1402 --openapi ../public/openapi.json

npx @solana/pay --sandbox curl "http://127.0.0.1:1402/api/v1/seller?marketplace=ebay&handle=some_seller"

npx @solana/pay --sandbox curl -X POST http://127.0.0.1:1402/api/v1/supplier \\
  -H "Content-Type: application/json" \\
  -d '{"vatCountry":"IE","vatNumber":"6388047V","name":"Cheap Phones Direct","domain":"this-shop-does-not-exist-sigpath-9471.com"}'`}</code>
      </pre>

      <h2>Example: a borrowed VAT number</h2>
      <p className="hint">A real response from the supplier check, against the live EU VAT register and the .com registry.</p>
      <pre className="code-block">
        <code>{EXAMPLE}</code>
      </pre>

      <h2>What the answers mean</h2>
      <ul className="evidence">
        <li className="info">
          <strong>Verified seller / business</strong> vouches for <em>who runs an account</em>, not for any item. Every answer
          carries a <code>meaning</code> field saying so, for your users.
        </li>
        <li className="info">
          <strong>Unknown is not bad.</strong> Checks that couldn&apos;t run say why (a register that doesn&apos;t publish
          names, a registry without dates). Most businesses haven&apos;t verified with SigPath.
        </li>
        <li className="info">
          <strong>Nothing you send is stored.</strong> Supplier details go only to the public registers they&apos;re checked
          against.
        </li>
      </ul>
      <p className="hint" style={{ marginTop: 20 }}>
        Building an AI shopping agent? See <Link href="/agents">For AI agents</Link>.
      </p>
    </main>
  );
}
