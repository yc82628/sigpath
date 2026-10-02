import type { Metadata } from "next";
import Link from "next/link";
import { Plus_Jakarta_Sans } from "next/font/google";
import { SLOGAN, Wordmark } from "./components/Logo";
import Assistant from "./components/Assistant";
import "./globals.css";

// Self-hosted at build time by next/font: no request to Google from a shopper's browser.
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

export const metadata: Metadata = {
  title: `SigPath — ${SLOGAN}`,
  description: "Compare eBay, Amazon and Etsy in one search. Every deal price-checked, every seller screened, and you only pay when it ships.",
};

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
              <Link href="/search">Search</Link>
              <Link href="/alerts">Alerts</Link>
              <Link href="/seller/verify">For sellers</Link>
            </nav>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="site-footer-inner">
            <p className="footer-links">
              <strong>SigPath</strong>
              <Link href="/how">How it works</Link>
              <Link href="/alerts">Price alerts</Link>
              <Link href="/seller/verify">For sellers</Link>
              <Link href="/agents">For AI agents</Link>
            </p>
            <p className="hint">
              No account, no tracking. &ldquo;Checked&rdquo; means our price and seller checks passed, not a guarantee the
              item is genuine.
            </p>
          </div>
        </footer>
        {/* Offered only where it can answer: the server needs a Claude API key. */}
        {process.env.ANTHROPIC_API_KEY && <Assistant />}
      </body>
    </html>
  );
}
