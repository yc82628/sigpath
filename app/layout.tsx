import type { Metadata } from "next";
import Link from "next/link";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font: no request to Google from a shopper's browser.
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

export const metadata: Metadata = {
  title: "SigPath — every deal checked",
  description: "Compare eBay, Amazon and Etsy in one search. Every deal price-checked, every seller screened, and you only pay when it ships.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand" aria-label="SigPath home">
              <span className="brand-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              SigPath
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
            <p>
              <strong>SigPath</strong> compares marketplaces and checks every deal. No account, no tracking: a search stores
              nothing unless you turn on a price alert.
            </p>
            <p className="hint">
              &ldquo;SigPath-checked&rdquo; means the price and seller checks passed, not that an item is guaranteed genuine.
              If something isn&apos;t right, buyers who paid through SigPath can report it.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
