import Link from "next/link";
import { labelledSearch } from "@/lib/marketplace/labelled-search";
import { agentCheck } from "@/lib/agents/check";
import { withoutEtsy } from "@/lib/marketplace/etsy-terms";

export const metadata = { title: "For AI agents — SigPath" };

// The example response is a real one, refreshed hourly, so it can never drift
// from what the endpoint actually returns.
export const revalidate = 3600;

const EXAMPLE_QUERY = "ThinkPad X1";
const PRICE_USDC = "0.002";

async function example(): Promise<string> {
  const full = agentCheck(EXAMPLE_QUERY, withoutEtsy(await labelledSearch(EXAMPLE_QUERY, { limit: 20 })));
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
  return (
    <main className="container wide agents">
      <h1>For AI agents</h1>
      <p className="lede">
        Shopping agents can ask SigPath before they buy. Pay per check in USDC on Solana through{" "}
        <a href="https://pay.sh" rel="noopener">pay.sh</a>, with no account and no API key.
      </p>

      <ol className="agent-steps">
        <li>
          <strong>Ask</strong>
          <code>GET /api/check?q=…</code>
        </li>
        <li>
          <strong>Pay</strong>
          <span>{PRICE_USDC} USDC, approved by the agent&apos;s wallet</span>
        </li>
        <li>
          <strong>Act</strong>
          <span>Best checked deal, and why the others aren&apos;t</span>
        </li>
      </ol>

      <h2>Try it in the sandbox</h2>
      <p className="hint">Test network and test USDC: nothing real is spent.</p>
      <pre className="code-block">
        <code>{`npx @solana/pay --sandbox gate api paysh/sigpath.yaml --bind 127.0.0.1:1402
npx @solana/pay --sandbox curl "http://127.0.0.1:1402/api/check?q=ThinkPad%20X1"`}</code>
      </pre>

      <h2>Funding the agent&apos;s wallet</h2>
      <p className="hint">
        On mainnet an agent pays from a Solana wallet holding a little USDC, plus a little SOL for network fees. The{" "}
        <a href="https://www.moonpay.com/agents" rel="noopener">MoonPay CLI</a> gives an agent its own wallet and buys
        crypto with a card. Its keys stay on the machine it runs on: write down the recovery phrase it shows you. Not
        needed for the sandbox above.
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
        If the agent pays from a different wallet, send the USDC there; <code>mp tools</code> lists every command. The
        MoonPay CLI is MoonPay&apos;s, not SigPath&apos;s: SigPath never sees the wallet or the purchase.
      </p>

      <h2>What comes back</h2>
      <p className="hint">A live answer from the demo feed, trimmed to one deal and one warning.</p>
      <pre className="code-block">
        <code>{sample}</code>
      </pre>

      <p className="hint">
        &ldquo;Checked&rdquo; is not a guarantee, and every answer says so: an agent passing a verdict on should pass that
        line on too. Shoppers can <Link href="/">search here</Link> for free. Verifying sellers, businesses or suppliers? See the{" "}
        <Link href="/developers">SigPath API</Link>.
      </p>
    </main>
  );
}
