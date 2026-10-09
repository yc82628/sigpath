import Link from "next/link";
import { claimMarketplaces } from "@/lib/sellers/claim";
import VerifyForm from "./VerifyForm";

/**
 * app/seller/verify/page.tsx — sellers claim the verified-seller badge.
 *
 * Says up front what the badge is and is not, because a badge that promises
 * more than it checks is worse than no badge.
 */

export const dynamic = "force-dynamic";

const NAMES: Record<string, string> = { ebay: "eBay", etsy: "Etsy" };

export default function VerifyPage() {
  const marketplaces = claimMarketplaces();
  const real = marketplaces.filter((m) => m !== "stub").map((m) => NAMES[m]);
  return (
    <main className="container">
      <h1>Become a verified seller</h1>
      <p className="lede">
        {real.length ? `Sell on ${real.join(" or ")}? ` : ""}Prove the account is yours and that a real person runs it, and your
        listings show a <strong>Verified seller</strong> badge on every SigPath search.
      </p>

      <p className="hint">
        Run a registered business? After verifying, <Link href="/seller/business">verify your business</Link> too:
        your VAT number, your website, and all your accounts under one profile.
      </p>

      <section className="guarantees">
        <h2>What it checks, and what it doesn&apos;t</h2>
        <ul>
          <li>
            <strong>You control the account:</strong> you put a one-time code in one of your listings, and
            SigPath reads it back through the marketplace&apos;s own API.
          </li>
          <li>
            <strong>You hold the wallet:</strong> you sign a message with it. The badge is a token in that
            wallet that <strong>can&apos;t be transferred or sold</strong>.
          </li>
          <li>
            <strong>A real person is behind it:</strong> a live photo with a handwritten code, checked and
            discarded. No picture or face data is kept.
          </li>
          <li>
            It is <strong>revoked</strong> if a buyer&apos;s fake-product report against the account is upheld
            — and an account with an upheld report can&apos;t be verified at all. The badge lasts a year.
          </li>
          <li>
            It does <strong>not</strong> vouch for any particular item, and it can&apos;t stop someone opening
            a new account. What it does is make &ldquo;verified&rdquo; visibly different from &ldquo;no
            track record&rdquo;.
          </li>
        </ul>
      </section>

      {marketplaces.length ? (
        <VerifyForm explorerBase="https://explorer.solana.com" marketplaces={marketplaces} />
      ) : (
        <p className="notice">Seller verification isn&apos;t switched on for this site yet.</p>
      )}

      <p className="hint" style={{ marginTop: 24 }}>
        <Link href="/search">Back to search</Link>
      </p>
    </main>
  );
}
