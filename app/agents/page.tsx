import Link from "next/link";
import { labelledSearch } from "@/lib/marketplace/labelled-search";
import { agentCheck } from "@/lib/agents/check";
import { withoutSiteOnly } from "@/lib/marketplace/site-only";
import { getLang } from "@/lib/i18n/server";

export function generateMetadata() {
  return { title: getLang() === "de" ? "Für KI-Agenten — SigPath" : "For AI agents — SigPath" };
}

// The example response is a real one, refreshed hourly, so it can never drift
// from what the endpoint actually returns.
export const revalidate = 3600;

const EXAMPLE_QUERY = "ThinkPad X1";
const PRICE_USDC = "0.002";

async function example(): Promise<string> {
  const full = agentCheck(EXAMPLE_QUERY, withoutSiteOnly(await labelledSearch(EXAMPLE_QUERY, { limit: 20 })));
  const trimmed = {
    query: full.query,
    bestChecked: full.bestChecked.slice(0, 1),
    listings: [full.listings.find((l) => l.verdict === "caution") ?? full.listings[0]].filter(Boolean),
    counts: full.counts,
    searched: full.searched,
    checkedMeans: full.checkedMeans,
  };
  return JSON.stringify(trimmed, null, 2);
}

export default async function AgentsPage() {
  const sample = await example();
  const de = getLang() === "de";
  const T = (en: string, german: string) => (de ? german : en);
  return (
    <main className="container wide agents">
      <h1>{T("For AI agents", "Für KI-Agenten")}</h1>
      <p className="lede">
        {T(
          "Shopping agents can ask SigPath before they buy. Pay per check in USDC on Solana through ",
          "Einkaufsagenten können SigPath fragen, bevor sie kaufen. Bezahlt wird pro Prüfung in USDC auf Solana über ",
        )}
        <a href="https://pay.sh" rel="noopener">
          pay.sh
        </a>
        {T(", with no account and no API key.", ", ohne Konto und ohne API-Schlüssel.")}
      </p>

      <ol className="agent-steps">
        <li>
          <strong>{T("Ask", "Anfragen")}</strong>
          <code>GET /api/check?q=…</code>
        </li>
        <li>
          <strong>{T("Pay", "Bezahlen")}</strong>
          <span>
            {de ? PRICE_USDC.replace(".", ",") : PRICE_USDC} {T("USDC, approved by the agent's wallet", "USDC, bestätigt von der Wallet des Agenten")}
          </span>
        </li>
        <li>
          <strong>{T("Act", "Handeln")}</strong>
          <span>{T("Best checked deal, and why the others aren't", "Das beste geprüfte Angebot, und warum die anderen es nicht sind")}</span>
        </li>
      </ol>

      <h2>{T("Try it in the sandbox", "In der Sandbox ausprobieren")}</h2>
      <p className="hint">{T("Test network and test USDC: nothing real is spent.", "Testnetz und Test-USDC: Es wird kein echtes Geld ausgegeben.")}</p>
      <pre className="code-block">
        <code>{`npx @solana/pay --sandbox gate api paysh/sigpath.yaml --bind 127.0.0.1:1402
npx @solana/pay --sandbox curl "http://127.0.0.1:1402/api/check?q=ThinkPad%20X1"`}</code>
      </pre>

      <h2>{T("Funding the agent's wallet", "Die Wallet des Agenten aufladen")}</h2>
      <p className="hint">
        {T(
          "On mainnet an agent pays from a Solana wallet holding a little USDC, plus a little SOL for network fees. The ",
          "Im Mainnet bezahlt ein Agent aus einer Solana-Wallet mit etwas USDC und etwas SOL für die Netzwerkgebühren. Die ",
        )}
        <a href="https://www.moonpay.com/agents" rel="noopener">
          MoonPay CLI
        </a>
        {T(
          " gives an agent its own wallet and buys crypto with a card. Its keys stay on the machine it runs on: write down the recovery phrase it shows you. Not needed for the sandbox above.",
          " gibt einem Agenten eine eigene Wallet und kauft Krypto per Karte. Die Schlüssel bleiben auf dem Rechner, auf dem sie läuft: Schreib dir die angezeigte Wiederherstellungsphrase auf. Für die Sandbox oben nicht nötig.",
        )}
      </p>
      <pre className="code-block">
        <code>{`npm i -g @moonpay/cli
mp login --email you@example.com          # then mp verify with the emailed code
mp wallet create --name "agent"
mp buy --token SOL --chain solana --amount 1 --wallet agent
mp token swap --wallet agent --chain solana \\
  --from-token So11111111111111111111111111111111111111111 --from-amount 0.1 \\
  --to-token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   # SOL to USDC
mp token balance list --wallet <address> --chain solana`}</code>
      </pre>
      <p className="hint">
        {T("If the agent pays from a different wallet, send the USDC there; ", "Bezahlt der Agent aus einer anderen Wallet, schick die USDC dorthin; ")}
        <code>mp tools</code>
        {T(
          " lists every command. The MoonPay CLI is MoonPay's, not SigPath's: SigPath never sees the wallet or the purchase.",
          " listet alle Befehle. Die MoonPay CLI gehört MoonPay, nicht SigPath: SigPath sieht weder die Wallet noch den Kauf.",
        )}
      </p>

      <h2>{T("What comes back", "Was zurückkommt")}</h2>
      <p className="hint">
        {T(
          "A live answer from the demo feed, trimmed to one deal and one warning.",
          "Eine Live-Antwort aus dem Demo-Feed, gekürzt auf ein Angebot und eine Warnung. Die API antwortet auf Englisch.",
        )}
      </p>
      <pre className="code-block">
        <code>{sample}</code>
      </pre>

      <p className="hint">
        {T(
          "“Checked” is not a guarantee, and every answer says so: an agent passing a verdict on should pass that line on too. Shoppers can ",
          "„Geprüft“ ist keine Garantie, und jede Antwort sagt das: Ein Agent, der ein Urteil weitergibt, sollte diesen Satz mitgeben. Käufer können ",
        )}
        <Link href="/">{T("search here", "hier suchen")}</Link>
        {T(" for free. Verifying sellers, businesses or suppliers? See the ", ", kostenlos. Du prüfst Verkäufer, Unternehmen oder Lieferanten? Siehe die ")}
        <Link href="/developers">{T("SigPath API", "SigPath-API")}</Link>.
      </p>
    </main>
  );
}
