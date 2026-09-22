import Link from "next/link";

export default function Home() {
  return (
    <main className="container">
      <h1>SigPath</h1>
      <p className="lede">
        Search several marketplaces at once, and see the checks no single
        marketplace can run on itself &mdash; a price far below the cross-platform
        median, or one photograph under two seller accounts.
      </p>
      <p className="lede">
        The trust half is attested on chain. Attestations originate on Solana and
        mirror to Base; Solana is the source of truth, and a copy is issued into
        the Solana Attestation Service so any app can read a verification without
        integrating with SigPath.
      </p>
      <p>
        <Link href="/search">Search marketplaces</Link> &middot;{" "}
        <Link href="/capture">Verify an identity</Link>
      </p>
      <p className="hint">
        No accounts anywhere: search stores nothing, and verification commits to a
        hash of the handle rather than the handle itself.
      </p>
    </main>
  );
}
