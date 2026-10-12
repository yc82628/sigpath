import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import { SLOGAN, Wordmark } from "./components/Logo";
import Assistant from "./components/Assistant";
import { assistantConfig, providerName } from "@/lib/assistant/models";
import { AMAZON_PRICE_DISCLAIMER, aliexpressAffiliate, amazonTag, operator } from "@/lib/legal/site";
import { visitCounterOn } from "@/lib/visits";
import VisitCounter from "./components/VisitCounter";
import SaleDayBanner from "./components/SaleDayBanner";
import PopIcon, { type Tone } from "./components/PopIcon";
import CartLink from "./components/CartLink";
import type { IconName } from "./components/icon-paths";

/** The header menu: only what SigPath has. The cart sits after Search; no profile or settings, as there are no accounts. */
const NAV: { href: string; label: string; icon: IconName; tone: Tone }[] = [
  { href: "/search", label: "Search", icon: "magnifying-glass", tone: "purple" },
  { href: "/alerts", label: "Price alerts", icon: "bell-ringing", tone: "blue" },
  { href: "/seller/verify", label: "For sellers", icon: "storefront", tone: "green" },
  { href: "/how", label: "About SigPath", icon: "info", tone: "purple" },
];
import "./globals.css";

// Self-hosted at build time by next/font: no request to Google from a shopper's browser.
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

export const metadata: Metadata = {
  title: `SigPath — ${SLOGAN}`,
  description: "Live prices in one search. Every deal price-checked, every seller screened, and you only pay when it ships.",
};

/** Offered only where it can answer: a model must be configured (lib/assistant/models.ts). */
function ShoppingAssistant() {
  const config = assistantConfig();
  return config ? <Assistant poweredBy={providerName(config)} /> : null;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand" aria-label="SigPath home">
              <Wordmark />
            </Link>
            {/* Icons only: each link's name is its aria-label (read out) and its data-label (shown on hover and focus). */}
            <nav className="site-nav" aria-label="Main">
              {NAV.map((n, i) => (
                <Fragment key={n.href}>
                  <Link href={n.href} className="nav-icon" aria-label={n.label} data-label={n.label}>
                    <PopIcon name={n.icon} tone={n.tone} size={22} onDark />
                  </Link>
                  {i === 0 && (
                    <CartLink>
                      <PopIcon name="shopping-cart-simple" tone="green" size={22} onDark />
                    </CartLink>
                  )}
                </Fragment>
              ))}
            </nav>
          </div>
        </header>
        <SaleDayBanner />
        {children}
        <footer className="site-footer">
          <div className="site-footer-inner">
            <p className="footer-links">
              <strong>SigPath</strong>
              <Link href="/how">How it works</Link>
              <Link href="/alerts">Price alerts</Link>
              <Link href="/seller/verify">For sellers</Link>
              <Link href="/check">Check a price</Link>
              <Link href="/suppliers">Check a supplier</Link>
              <Link href="/developers">API</Link>
              <Link href="/impressum">Impressum</Link>
              <Link href="/privacy">Privacy</Link>
            </p>
            <p className="hint">
              No account, no tracking cookies{visitCounterOn() ? "; visits are counted" : ""}. &ldquo;Checked&rdquo; is not a
              guarantee an item is genuine.
            </p>
            {aliexpressAffiliate() && (
              <p className="hint">SigPath may earn a commission when you buy on AliExpress through its links.</p>
            )}
            {amazonTag() && (
              <p className="hint">
                As an Amazon Associate, SigPath earns from qualifying purchases. (Als Amazon-Partner verdient SigPath an
                qualifizierten Verkäufen.) {AMAZON_PRICE_DISCLAIMER}
              </p>
            )}
            {/* The holder is the Impressum's name once it's set (an env var, never the repo), else SigPath. The code
                itself is MIT-licensed (LICENSE), so the line says so rather than "all rights reserved". */}
            <p className="copyright">
              &copy; {new Date().getFullYear()} {operator()?.name ?? "SigPath"}. The SigPath name and logo: all rights
              reserved. The code is open source under the{" "}
              <a href="https://github.com/yc82628/sigpath/blob/main/LICENSE" rel="noopener">
                MIT licence
              </a>
              .
            </p>
          </div>
        </footer>
        <ShoppingAssistant />
        {visitCounterOn() && <VisitCounter />}
      </body>
    </html>
  );
}
