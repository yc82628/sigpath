import Link from "next/link";
import PopIcon from "../components/PopIcon";

export const metadata = { title: "How SigPath keeps fakes out" };

export default function HowPage() {
  return (
    <main className="container wide how">
      <h1>How SigPath keeps fakes out</h1>
      <ol className="steps">
        <li className="with-icon">
          <PopIcon name="shield-check" tone="purple" size={30} />
          <span>
            <strong>Checked before you buy.</strong> Bait prices, recycled photos and brand-new seller accounts are flagged
            on every result.
          </span>
        </li>
        <li className="with-icon">
          <PopIcon name="camera" tone="blue" size={30} />
          <span>
            <strong>Reported by real buyers.</strong> Only people who actually paid can report a fake, with a live photo of
            what arrived.
          </span>
        </li>
        <li className="with-icon">
          <PopIcon name="gavel" tone="green" size={30} />
          <span>
            <strong>Penalties that stick.</strong> An upheld report flags the seller everywhere and is recorded publicly on
            Solana — a fresh listing doesn&apos;t wash it away.
          </span>
        </li>
        <li className="with-icon">
          <PopIcon name="seal-check" tone="purple" size={30} />
          <span>
            <strong>Sellers can earn trust.</strong> Verified sellers prove the account is theirs and carry a badge that
            can&apos;t be bought, sold or transferred.
          </span>
        </li>
      </ol>
      <h2 className="with-icon">
        <PopIcon name="vault" tone="blue" size={28} />
        Your money is protected
      </h2>
      <p className="hint">
        Pay through SigPath and your money waits in escrow. If the order isn&apos;t fulfilled in time, it comes back to you
        automatically.
      </p>
      <p className="how-cta">
        <Link className="button" href="/">
          Start comparing
        </Link>{" "}
        <Link className="button ghost" href="/alerts">
          Your price alerts
        </Link>
      </p>
    </main>
  );
}
