import Link from "next/link";
import { labelledSearch } from "@/lib/marketplace/labelled-search";
import { agentCheck } from "@/lib/agents/check";

export const metadata = { title: "For AI agents — SigPath" };

// The example response is a real one, refreshed hourly, so it can never drift
// from what the endpoint actually returns.
export const revalidate = 3600;

const EXAMPLE_QUERY = "ThinkPad X1";
const PRICE_USDC = "0.002";

async function example(): Promise<string> {
  const full = agentCheck(EXAMPLE_QUERY, await labelledSearch(EXAMPLE_QUERY, { limit: 20 }));
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
