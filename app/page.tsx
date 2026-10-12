import Link from "next/link";
import { Badge, SLOGAN } from "./components/Logo";
import { aliexpressOn } from "@/lib/legal/site";
import HeroDevices, { Smoke } from "./components/HeroDevices";
import PopIcon, { TONES } from "./components/PopIcon";
import type { IconName } from "./components/icon-paths";
import { getMessages } from "@/lib/i18n/server";
import { CATEGORIES, categoryHref } from "./components/catalog";

const POPULAR = ["AirPods Pro", "Nintendo Switch OLED", "ThinkPad X1", "Nike Air Max 90"];

const PROMISES: { title: string; line: string; icon: IconName }[] = [
  { title: "Best price", line: "Live prices in one search", icon: "tag" },
  { title: "Every deal checked", line: "Too good to be true? We say so", icon: "seal-check" },
  { title: "Pay when it ships", line: "Your money waits safely until then", icon: "lock-key" },
];

export default function Home() {
  const m = getMessages();
  // Only the marketplaces actually searched: eBay, and AliExpress once its keys are set.
  const markets = ["eBay", ...(aliexpressOn() ? ["AliExpress"] : [])];
  return (
    <main>
      <Smoke />
      <section className="hero">
        <div className="hero-inner">
          <Badge className="hero-badge" />
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
          <form className="searchbar hero-search" method="GET" action="/search">
            <input type="search" name="q" placeholder={m.home.placeholder} aria-label={m.home.searchLabel} />
            <button type="submit">{m.home.searchButton}</button>
          </form>
          <ul className="hero-chips" aria-label={m.home.popular}>
            {POPULAR.map((p) => (
              <li key={p}>
                <Link href={`/search?q=${encodeURIComponent(p)}`}>{p}</Link>
              </li>
            ))}
          </ul>
          <ul className="market-row" aria-label={m.home.markets}>
            {markets.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="hero-more">
            {m.home.foundElsewhere} <Link href="/check">{m.home.checkThatPrice}</Link>
          </p>
        </div>
        <HeroDevices label={m.home.devices} caption={m.home.devicesCaption} />
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
      </section>

      <section className="container wide home-section" aria-label={m.home.why}>
        <ul className="promise-row">
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
        <p className="home-more">
          <Link href="/how">{m.home.howFakes}</Link>
        </p>
      </section>
    </main>
  );
}
