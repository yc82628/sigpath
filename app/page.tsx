import Link from "next/link";
import { Badge, SLOGAN } from "./components/Logo";

const POPULAR = ["AirPods Pro", "Nintendo Switch OLED", "ThinkPad X1", "Nike Air Max 90"];

// Line icons (24px grid, stroked) so the tiles read at a glance without words.
const CATEGORIES: { label: string; q: string; icon: React.ReactNode }[] = [
  {
    label: "Headphones",
    q: "AirPods Pro",
    icon: <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />,
  },
  {
    label: "Phones",
    q: "iPhone 15",
    icon: (
      <>
        <rect x="6" y="2" width="12" height="20" rx="2.5" />
        <path d="M11 18h2" />
      </>
    ),
  },
  {
    label: "Laptops",
    q: "ThinkPad X1",
    icon: <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.3 2.6a1 1 0 0 1-.9 1.4H3.6a1 1 0 0 1-.9-1.4L4 16" />,
  },
  {
    label: "Gaming",
    q: "Nintendo Switch OLED",
    icon: (
      <>
        <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" />
        <path d="M17.3 5H6.7a4 4 0 0 0-4 3.6C2.6 9.4 2 14.5 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.4-1.4A2 2 0 0 1 9.8 16h4.4a2 2 0 0 1 1.4.6L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.5-.6-6.6-.7-7.3A4 4 0 0 0 17.3 5z" />
      </>
    ),
  },
  {
    label: "Sneakers",
    q: "Nike Air Max 90",
    icon: <path d="M2 17v-4.5L6 7l3 2 2.5 3H15l5 2.2A2 2 0 0 1 22 16v1H2zM2 17v1.5h20V17M9.5 11 8 12.5M12 13l-1.5 1.5" />,
  },
  {
    label: "Watches",
    q: "Apple Watch",
    icon: (
      <>
        <circle cx="12" cy="12" r="6" />
        <path d="M12 10v2l1 1M16.1 7.7l-.8-4.1a2 2 0 0 0-2-1.6h-2.7a2 2 0 0 0-2 1.6l-.8 4.1M7.9 16.4l.8 4a2 2 0 0 0 2 1.6h2.7a2 2 0 0 0 2-1.6l.8-4" />
      </>
    ),
  },
  {
    label: "Cameras",
    q: "Sony A7 III",
    icon: (
      <>
        <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
        <circle cx="12" cy="13" r="3" />
      </>
    ),
  },
  {
    label: "Handmade",
    q: "handmade ceramic mug",
    icon: (
      <>
        <rect x="3" y="8" width="18" height="4" rx="1" />
        <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5" />
      </>
    ),
  },
];

const PROMISES = [
  { title: "Best price", line: "eBay, Amazon and Etsy in one search", icon: <path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" /> },
  { title: "Every deal checked", line: "Too good to be true? We say so", icon: <path d="M5 12.5l4.2 4.2L19 7" />, ok: true },
  { title: "Pay when it ships", line: "Your money waits safely until then", icon: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></> },
];

function Icon({ children, size = 26 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export default function Home() {
  return (
    <main>
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
          <p className="hero-sub">Every deal compared. Every deal checked.</p>
          <form className="searchbar hero-search" method="GET" action="/search">
            <input type="search" name="q" placeholder="Search any product" aria-label="Search all marketplaces" />
            <button type="submit">Search</button>
          </form>
          <ul className="hero-chips" aria-label="Popular searches">
            {POPULAR.map((p) => (
              <li key={p}>
                <Link href={`/search?q=${encodeURIComponent(p)}`}>{p}</Link>
              </li>
            ))}
          </ul>
          <ul className="market-row" aria-label="Marketplaces searched">
            <li className="m-ebay">eBay</li>
            <li className="m-amazon">Amazon</li>
            <li className="m-etsy">Etsy</li>
          </ul>
        </div>
      </section>

      <section className="container wide home-section" aria-labelledby="browse">
        <h2 id="browse" className="section-title">Start browsing</h2>
        <ul className="category-grid">
          {CATEGORIES.map((c) => (
            <li key={c.label}>
              <Link className="category-tile" href={`/search?q=${encodeURIComponent(c.q)}`}>
                <span className="category-icon">
                  <Icon>{c.icon}</Icon>
                </span>
                {c.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="container wide home-section" aria-label="Why SigPath">
        <ul className="promise-row">
          {PROMISES.map((p) => (
            <li key={p.title} className="promise-item">
              <span className={p.ok ? "promise-icon ok" : "promise-icon"}>
                <Icon size={22}>{p.icon}</Icon>
              </span>
              <span>
                <strong>{p.title}</strong>
                <span className="promise-line">{p.line}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="home-more">
          <Link href="/how">How we keep fakes out &rarr;</Link>
        </p>
      </section>
    </main>
  );
}
