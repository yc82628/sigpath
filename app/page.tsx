import Link from "next/link";
import { Suspense } from "react";
import HotDeals, { PopularSearches } from "./components/HotDeals";
import { Badge, SLOGAN } from "./components/Logo";
import { aliexpressOn } from "@/lib/legal/site";
import HeroDevices, { Smoke } from "./components/HeroDevices";
import ProofStrip from "./components/ProofStrip";
import PopIcon, { TONES } from "./components/PopIcon";
import type { IconName } from "./components/icon-paths";
import { getLang, getMessages } from "@/lib/i18n/server";
import { CATEGORIES, categoryHref } from "./components/catalog";
import { MARKET_LOGOS, type Logo, type Market } from "./components/market-logos";

const POPULAR = ["AirPods Pro", "Nintendo Switch OLED", "ThinkPad X1", "Nike Air Max 90"];

const PROMISES: { title: string; line: string; icon: IconName }[] = [
  { title: "Best real deal", line: "The cheapest offer that passes our checks", icon: "seal-check" },
  { title: "Know the real price", line: "Typical price and range, live from the market", icon: "tag" },
  { title: "Pay when it ships", line: "Your money waits safely until then", icon: "lock-key" },
];

const DIFF_ICONS: IconName[] = ["magnifying-glass", "tag", "shield-check"];

export default function Home() {
  const m = getMessages();
  // Each marketplace as it really is: eBay searched; AliExpress searched once its keys are set, "coming soon" until
  // then; Amazon not searched, only its prices checked on /check, and tagged so.
  const markets: { name: Market; tag?: string; href?: string; title?: string }[] = [
    { name: "eBay" },
    { name: "AliExpress", tag: aliexpressOn() ? undefined : m.home.soonTag },
    { name: "Amazon", tag: m.home.priceCheckTag, href: "/check", title: m.home.priceCheckTitle },
  ];
  return (
    <main>
      <Smoke />
      <section className="hero">
        <div className="hero-inner">
          <Badge className="hero-badge" />
          {/* The slogan on its own backing, so the smoke behind it never washes the words out. */}
          <div className="hero-plate">
          <h1 className="hero-title">
            {/* Wraps between the two halves, never inside one. */}
            {SLOGAN.split(" – ").map((half, i) => (
              <span key={half} className="nowrap">
                {i > 0 && " "}
                {half}
                {i === 0 && " –"}
              </span>
            ))}
          </h1>
          <p className="hero-sub">{m.home.sub}</p>
          </div>
          <form className="searchbar hero-search" method="GET" action="/search">
            <input type="search" name="q" placeholder={m.home.placeholder} aria-label={m.home.searchLabel} />
            <button type="submit">{m.home.searchButton}</button>
          </form>
          {/* What's selling fast on AliExpress, once its keys are set; the popular searches until it answers, and
              without it. eBay publishes no sales figures, so it never feeds this. */}
          {aliexpressOn() ? (
            <Suspense fallback={<PopularSearches label={m.home.popular} queries={POPULAR} />}>
              <HotDeals fallback={<PopularSearches label={m.home.popular} queries={POPULAR} />} />
            </Suspense>
          ) : (
            <PopularSearches label={m.home.popular} queries={POPULAR} />
          )}
          <ul className="market-row" aria-label={m.home.markets}>
            {markets.map((k) => {
              const logo: Logo = MARKET_LOGOS[k.name];
              const paintId = `logo-${k.name.toLowerCase()}`;
              const body = (
                <>
                  {/* A logo that is the name itself leaves the written name to screen readers. */}
                  <span className="market-mark">
                    <svg
                      className={`market-logo market-${k.name.toLowerCase()}`}
                      viewBox={logo.box}
                      aria-hidden="true"
                      focusable="false"
                    >
                      {logo.letters && (
                        // One colour per letter: hard stops where each letter ends.
                        <defs>
                          <linearGradient id={paintId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="0">
                            {logo.letters.flatMap(([colour, end], i) => [
                              <stop key={`${i}a`} offset={(i ? logo.letters![i - 1][1] : 0) / 24} stopColor={colour} />,
                              <stop key={`${i}b`} offset={end / 24} stopColor={colour} />,
                            ])}
                          </linearGradient>
                        </defs>
                      )}
                      <path d={logo.d} fill={logo.letters ? `url(#${paintId})` : logo.hex} />
                    </svg>
                    <span className={logo.wordmark ? "sr-only" : "market-name"}>{k.name}</span>
                  </span>
                  {k.tag && <span className="market-tag">{k.tag}</span>}
                </>
              );
              return (
                <li key={k.name}>
                  {k.href ? (
                    <Link href={k.href} className="market" title={k.title}>
                      {body}
                    </Link>
                  ) : (
                    <span className="market">{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {/* Why use SigPath, in the first screen: under the search and the marketplaces. */}
          <ul className="promise-row hero-promises" aria-label={m.home.why}>
            {PROMISES.map((p, i) => (
              <li key={p.title} className="promise-item">
                <span className="promise-icon">
                  <PopIcon name={p.icon} tone={TONES[i % 3]} size={24} />
                </span>
                <span>
                  <strong>{m.home.promises[i]?.title ?? p.title}</strong>
                  <span className="promise-line">{m.home.promises[i]?.line ?? p.line}</span>
                </span>
              </li>
            ))}
          </ul>
          {/* Proof, not a promise: counted on Solana, so it streams in after the page. */}
          <Suspense fallback={null}>
            <ProofStrip />
          </Suspense>
          <p className="hero-more">
            {m.home.foundElsewhere} <Link href="/check">{m.home.checkThatPrice}</Link>
          </p>
        </div>
        <HeroDevices label={m.home.devices} caption={m.home.devicesCaption} lang={getLang()} />
      </section>

      {/* How the real deal is found: the market, a score on every offer, fakes filtered out (the record on Solana). */}
      <section className="container wide home-section" aria-labelledby="different">
        <h2 id="different" className="section-title">{m.home.diffTitle}</h2>
        <p className="hint diff-sub">{m.home.diffSub}</p>
        <ul className="diff-grid">
          {m.home.diff.map((d, i) => (
            <li key={d.title}>
              <span className="promise-icon">
                <PopIcon name={DIFF_ICONS[i]} tone={TONES[i % 3]} size={24} />
              </span>
              <strong>{d.title}</strong>
              <span>{d.line}</span>
            </li>
          ))}
        </ul>
        <p className="diff-links">
          <Link href="/proof">{m.home.proofLink}</Link>
          <Link href="/seller">{m.home.sellersLink}</Link>
        </p>
      </section>

      <section className="container wide home-section" aria-labelledby="browse">
        <h2 id="browse" className="section-title">{m.home.browse}</h2>
        <ul className="category-grid">
          {/* Icons in SigPath's Flex Pop style (PopIcon), the tone cycling through Solana's colours. */}
          {CATEGORIES.map((c, i) => (
            <li key={c.label}>
              <Link className="category-tile" href={categoryHref(c.q)}>
                <span className="category-icon">
                  <PopIcon name={c.icon} tone={TONES[i % 3]} size={30} />
                </span>
                {m.home.categories[c.label] ?? c.label}
              </Link>
            </li>
          ))}
        </ul>
        <p className="home-more">
          <Link href="/how">{m.home.howFakes}</Link>
        </p>
      </section>
    </main>
  );
}
