import Link from "next/link";
import BusinessForm from "./BusinessForm";

/**
 * app/seller/business — the verified-business tier, on top of verified accounts.
 * Says what it checks and what it doesn't before asking for anything.
 */

export const dynamic = "force-dynamic";
export const metadata = { title: "Verify your business — SigPath" };

export default function BusinessPage() {
  return (
    <main className="container">
      <h1>Verify your business</h1>
      <p className="lede">
        Already a verified seller? Show shoppers the registered business behind your accounts, on eBay, Etsy or both,
        with a <span className="verified business">✓ Verified business</span> badge and a public profile.
      </p>

      <section className="guarantees">
        <h2>What it checks, and what it doesn&apos;t</h2>
        <ul>
          <li>
            <strong>Your accounts belong together:</strong> every marketplace account you verified with the same wallet is
            linked. Nothing is guessed.
          </li>
          <li>
            <strong>You&apos;re a registered business:</strong> your EU VAT number, checked live against the EU&apos;s VIES
            register. The name shown comes from the register.
          </li>
          <li>
            <strong>Your website (optional):</strong> a one-time record in your domain&apos;s DNS.
          </li>
          <li>
            It vouches for <em>who runs the accounts</em>, not for any item. One upheld fake-product report against any
            linked account suspends it for all of them.
          </li>
        </ul>
      </section>

      <BusinessForm />

      <p className="hint" style={{ marginTop: 24 }}>
        Not verified yet? <Link href="/seller/verify">Become a verified seller</Link> first.
      </p>
    </main>
  );
}
