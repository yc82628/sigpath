import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { Fredoka, Nunito } from "next/font/google";
import { SLOGAN, Wordmark } from "./components/Logo";
import Assistant from "./components/Assistant";
import { assistantConfig, providerName } from "@/lib/assistant/models";
import { AMAZON_PRICE_DISCLAIMER, aliexpressAffiliate, amazonTag } from "@/lib/legal/site";
import { visitCounterOn } from "@/lib/visits";
import VisitCounter from "./components/VisitCounter";
import SaleDayBanner from "./components/SaleDayBanner";
import PopIcon, { TONES, type Tone } from "./components/PopIcon";
import CatalogMenu from "./components/CatalogMenu";
import { CATEGORIES } from "./components/catalog";
import CartLink from "./components/CartLink";
import type { IconName } from "./components/icon-paths";
import { LangProvider, LangSwitch } from "./components/I18n";
import { getLang } from "@/lib/i18n/server";
import { MESSAGES, type Messages } from "@/lib/i18n/messages";

/** The header menu: only what SigPath has. The cart sits after Search; no profile or settings, as there are no accounts. */
const NAV: { href: string; label: (m: Messages) => string; icon: IconName; tone: Tone }[] = [
  { href: "/search", label: (m) => m.nav.search, icon: "magnifying-glass", tone: "purple" },
  { href: "/alerts", label: (m) => m.nav.alerts, icon: "bell-ringing", tone: "blue" },
  { href: "/seller/verify", label: (m) => m.nav.sellers, icon: "storefront", tone: "green" },
  { href: "/how", label: (m) => m.nav.about, icon: "info", tone: "purple" },
];
import "./globals.css";

// Rounded like the Flex Pop icons' outlines: Fredoka for headings, Nunito for text. Self-hosted at build time by
// next/font: no request to Google from a shopper's browser.
const sans = Nunito({ subsets: ["latin"], display: "swap", variable: "--font-sans" });
const display = Fredoka({ subsets: ["latin"], display: "swap", variable: "--font-display" });

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
  // English or German, as the shopper chose (lib/i18n/lang.ts).
  const lang = getLang();
  const m = MESSAGES[lang];
  return (
    <html lang={lang} className={`${sans.variable} ${display.variable}`}>
      <body>
        <LangProvider lang={lang}>
        <header className="site-header">
          <div className="site-header-inner">
            <div className="site-header-start">
              <CatalogMenu
                categoryIcons={CATEGORIES.map((c, i) => (
                  <PopIcon key={c.icon} name={c.icon} tone={TONES[i % 3]} size={22} />
                ))}
              />
              <Link href="/" className="brand" aria-label={m.nav.home}>
                <Wordmark />
              </Link>
            </div>
            {/* Icons only: each link's name is its aria-label (read out) and its data-label (shown on hover and focus). */}
            <nav className="site-nav" aria-label={m.nav.main}>
              {NAV.map((n, i) => (
                <Fragment key={n.href}>
                  <Link href={n.href} className="nav-icon" aria-label={n.label(m)} data-label={n.label(m)}>
                    <PopIcon name={n.icon} tone={n.tone} size={22} onDark />
                  </Link>
                  {i === 0 && (
                    <CartLink>
                      <PopIcon name="shopping-cart-simple" tone="green" size={22} onDark />
                    </CartLink>
                  )}
                </Fragment>
              ))}
              <LangSwitch />
            </nav>
          </div>
        </header>
        <SaleDayBanner />
        {children}
        {/* Short on purpose: the menu at the top left lists every page. The affiliate lines show only while
            those programmes are switched on, as the programmes require. */}
        <footer className="site-footer">
          <div className="site-footer-inner">
            <div className="footer-row">
              <p className="copyright">{m.footer.copyright(new Date().getFullYear())}</p>
              <p className="footer-links">
                <Link href="/proof">{m.footer.proof}</Link>
                <Link href="/how">{m.footer.howItWorks}</Link>
                <Link href="/seller">{m.footer.forSellers}</Link>
                <Link href="/privacy">{m.footer.privacy}</Link>
                <Link href="/impressum">{m.footer.impressum}</Link>
                <Link href="/developers">{m.footer.api}</Link>
                <a href="https://github.com/yc82628/sigpath/blob/main/LICENSE" rel="noopener">
                  {m.footer.openSource}
                </a>
              </p>
            </div>
            <p className="footer-note">
              {m.footer.note(visitCounterOn())} {m.footer.marks}
              {aliexpressAffiliate() && <> {m.footer.aliexpress}</>}
              {amazonTag() && (
                <>
                  {" "}
                  As an Amazon Associate, SigPath earns from qualifying purchases. (Als Amazon-Partner verdient SigPath an
                  qualifizierten Verkäufen.) {AMAZON_PRICE_DISCLAIMER}
                </>
              )}
            </p>
          </div>
        </footer>
        <ShoppingAssistant />
        </LangProvider>
        {visitCounterOn() && <VisitCounter />}
      </body>
    </html>
  );
}
