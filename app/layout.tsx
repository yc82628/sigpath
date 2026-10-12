import type { Metadata } from "next";
import Link from "next/link";
import { Plus_Jakarta_Sans } from "next/font/google";
import { SLOGAN, Wordmark } from "./components/Logo";
import Assistant from "./components/Assistant";
import { assistantConfig, providerName } from "@/lib/assistant/models";
import { AMAZON_PRICE_DISCLAIMER, aliexpressAffiliate, amazonTag } from "@/lib/legal/site";
import { visitCounterOn } from "@/lib/visits";
import VisitCounter from "./components/VisitCounter";
import SaleDayBanner from "./components/SaleDayBanner";
import PopIcon from "./components/PopIcon";
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
            <nav className="site-nav" aria-label="Main">
              <Link href="/search" className="with-icon">
                <PopIcon name="magnifying-glass" tone="purple" size={18} neon />
                Search
              </Link>
              <Link href="/alerts" className="with-icon">
                <PopIcon name="bell-ringing" tone="blue" size={18} neon />
                Alerts
              </Link>
              <Link href="/seller/verify" className="with-icon">
                <PopIcon name="storefront" tone="green" size={18} neon />
                For sellers
              </Link>
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
              No account, no tracking cookies{visitCounterOn() ? "; visits are only counted" : ""}. &ldquo;Checked&rdquo; means our price and seller checks passed, not a guarantee the
              item is genuine.
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
          </div>
        </footer>
        <ShoppingAssistant />
        {visitCounterOn() && <VisitCounter />}
      </body>
    </html>
  );
}
