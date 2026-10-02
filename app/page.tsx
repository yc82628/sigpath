import Link from "next/link";

const EXAMPLES = ["AirPods Pro", "Nintendo Switch OLED", "ThinkPad X1", "Nike Air Max 90"];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-inner">
          <p className="eyebrow">eBay &middot; Amazon &middot; Etsy &middot; one search</p>
          <h1 className="hero-title">
            Every deal compared.
            <br />
            <span className="hero-accent">Every deal checked.</span>
          </h1>
          <p className="hero-sub">
            Find the best price across the big marketplaces — and see at a glance which deals passed SigPath&apos;s checks
            and which ones to look at twice.
          </p>
          <form className="searchbar hero-search" method="GET" action="/search">
            <input type="search" name="q" placeholder="What are you looking for?" aria-label="Search all marketplaces" />
            <button type="submit">Search</button>
          </form>
          <p className="hero-examples">
            Try{" "}
            {EXAMPLES.map((e, i) => (
              <span key={e}>
                <Link href={`/search?q=${encodeURIComponent(e)}`}>{e}</Link>
                {i < EXAMPLES.length - 1 ? " · " : ""}
              </span>
            ))}
          </p>
        </div>
      </section>

      <section className="promises container wide">
        <article className="promise">
          <span className="promise-icon" aria-hidden="true">&#8644;</span>
          <h2>The best price, everywhere</h2>
          <p>One search across eBay, Amazon and Etsy, with shipping included in every price — so the cheapest really is the cheapest.</p>
        </article>
        <article className="promise">
          <span className="promise-icon ok" aria-hidden="true">&#10003;</span>
          <h2>Every deal checked</h2>
          <p>
            Prices compared with the market for their condition, photos and seller accounts screened. A deal that&apos;s too
            good to be true says so.
          </p>
        </article>
        <article className="promise">
          <span className="promise-icon" aria-hidden="true">&#128274;</span>
          <h2>Paid only when it ships</h2>
          <p>
            Pay through SigPath and your money waits in escrow. If the order isn&apos;t fulfilled in time, it comes back to you
            automatically.
          </p>
        </article>
      </section>

      <section className="how container wide">
        <h2>How SigPath keeps fakes out</h2>
        <ol className="steps">
          <li>
            <strong>Checked before you buy.</strong> Bait prices, recycled photos and brand-new seller accounts are flagged
            on every result.
          </li>
          <li>
            <strong>Reported by real buyers.</strong> Only people who actually paid can report a fake, with a live photo of
            what arrived.
          </li>
          <li>
            <strong>Penalties that stick.</strong> An upheld report flags the seller everywhere and is recorded publicly on
            Solana — a fresh listing doesn&apos;t wash it away.
          </li>
          <li>
            <strong>Sellers can earn trust.</strong> Verified sellers prove the account is theirs and carry a badge that
            can&apos;t be bought, sold or transferred.
          </li>
        </ol>
        <p className="how-cta">
          <Link className="button" href="/search">
            Start comparing
          </Link>{" "}
          <Link className="button ghost" href="/alerts">
            Your price alerts
          </Link>
        </p>
      </section>
    </main>
  );
}
