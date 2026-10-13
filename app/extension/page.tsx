import Link from "next/link";
import PopIcon from "../components/PopIcon";
import type { IconName } from "../components/icon-paths";
import { getLang } from "@/lib/i18n/server";

/**
 * app/extension — a quick start for the SigPath browser extension (extension/):
 * three steps and a picture of it at work, rather than paragraphs. The details
 * are in the privacy notice. The extension opens this page when installed.
 * In English and German (the page's own words, below).
 */

export function generateMetadata() {
  return { title: getLang() === "de" ? "Die SigPath-Erweiterung — SigPath" : "The SigPath extension — SigPath" };
}

type Tone = "purple" | "blue" | "green";

const en = {
  title: "The SigPath extension",
  lede: "SigPath's check, right on the shop's page.",
  steps: [
    { icon: "plus" as IconName, tone: "purple" as Tone, title: "Add it", line: "To Chrome or Edge, once." },
    { icon: "shopping-cart-simple" as IconName, tone: "blue" as Tone, title: "Shop as usual", line: "Amazon, AliExpress, OTTO, MediaMarkt, Saturn." },
    { icon: "seal-check" as IconName, tone: "green" as Tone, title: "See the check", line: "Price vs eBay, red flags, the best deal." },
  ],
  picture: "The SigPath panel on an Amazon product page",
  iconTitle: "The extension's icon shows the verdict",
  product: "Wireless earbuds, 2nd gen",
  basket: "Add to basket",
  checked: "✓ Checked",
  below: "4 % below",
  belowRest: " eBay's typical price",
  best: "Best checked eBay deal: 205 €",
  soldBy: "Sold by: Amazon",
  caption: "On every product page: the check appears at the bottom right.",
  resultsLabel: "On Amazon's results:",
  chip: "Check with SigPath →",
  resultsRest: "under every price.",
  otherLabel: "Any other shop:",
  otherRest: "click the icon, then “Check this page”.",
  choiceLabel: "Your choice:",
  choiceRest: "sharing Amazon prices is off until you turn it on.",
  shared: "What's shared",
  install: "Install it",
  soon: "In the Chrome Web Store soon. Until then:",
  step1a: "Download SigPath from",
  step1b: "(Code → Download ZIP), unzip it.",
  step2a: "Open",
  step2b: ", turn on Developer mode.",
  step3a: "“Load unpacked” → the",
  step3b: "folder.",
};

const de: typeof en = {
  title: "Die SigPath-Erweiterung",
  lede: "SigPaths Prüfung direkt auf der Seite des Shops.",
  steps: [
    { icon: "plus", tone: "purple", title: "Hinzufügen", line: "Zu Chrome oder Edge, einmal." },
    { icon: "shopping-cart-simple", tone: "blue", title: "Einkaufen wie immer", line: "Amazon, AliExpress, OTTO, MediaMarkt, Saturn." },
    { icon: "seal-check", tone: "green", title: "Prüfung sehen", line: "Preis gegen eBay, Warnsignale, das beste Angebot." },
  ],
  picture: "Das SigPath-Fenster auf einer Amazon-Produktseite",
  iconTitle: "Das Symbol der Erweiterung zeigt das Urteil",
  product: "Kabellose Ohrhörer, 2. Generation",
  basket: "In den Einkaufswagen",
  checked: "✓ Geprüft",
  below: "4 % unter",
  belowRest: " dem typischen eBay-Preis",
  best: "Bestes geprüftes eBay-Angebot: 205 €",
  soldBy: "Verkauf durch: Amazon",
  caption: "Auf jeder Produktseite: Die Prüfung erscheint unten rechts.",
  resultsLabel: "In Amazons Suchergebnissen:",
  chip: "Mit SigPath prüfen →",
  resultsRest: "unter jedem Preis.",
  otherLabel: "Jeder andere Shop:",
  otherRest: "aufs Symbol klicken, dann „Diese Seite prüfen“.",
  choiceLabel: "Deine Wahl:",
  choiceRest: "Amazon-Preise teilen ist aus, bis du es einschaltest.",
  shared: "Was geteilt wird",
  install: "Installieren",
  soon: "Bald im Chrome Web Store. Bis dahin:",
  step1a: "SigPath von",
  step1b: "herunterladen (Code → Download ZIP) und entpacken.",
  step2a: "Öffne",
  step2b: " und schalte den Entwicklermodus ein.",
  step3a: "„Entpackte Erweiterung laden“ → den Ordner",
  step3b: "wählen.",
};

/** The extension at work on a product page: a drawing, not a screenshot of any real listing. */
function BrowserPicture({ t }: { t: typeof en }) {
  return (
    <figure className="qs-browser" aria-label={t.picture}>
      <div className="qs-bar" aria-hidden="true">
        <span className="qs-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="qs-url">amazon.de/…/dp/B0…</span>
        <span className="qs-ext" title={t.iconTitle}>
          ✓
        </span>
      </div>
      <div className="qs-page" aria-hidden="true">
        <div className="qs-product">
          <div className="qs-photo">
            <PopIcon name="headphones" tone="blue" size={56} />
          </div>
          <div className="qs-lines">
            <b>{t.product}</b>
            <span className="qs-price">229,00 €</span>
            <span className="qs-line" />
            <span className="qs-line short" />
            <span className="qs-buy">{t.basket}</span>
          </div>
        </div>
        <div className="qs-panel">
          <span className="qs-brand">SigPath</span>
          <span className="qs-pill">{t.checked}</span>
          <span>
            <b>{t.below}</b>
            {t.belowRest}
          </span>
          <span className="qs-muted">{t.best}</span>
          <span className="qs-muted">{t.soldBy}</span>
        </div>
      </div>
      <figcaption>{t.caption}</figcaption>
    </figure>
  );
}

export default function ExtensionPage() {
  const t = getLang() === "de" ? de : en;
  return (
    <main className="container quick-start">
      <h1>{t.title}</h1>
      <p className="lede">{t.lede}</p>

      <ol className="qs-steps">
        {t.steps.map((s, i) => (
          <li key={s.icon}>
            <span className="qs-num">{i + 1}</span>
            <PopIcon name={s.icon} tone={s.tone} size={30} />
            <strong>{s.title}</strong>
            <span>{s.line}</span>
          </li>
        ))}
      </ol>

      <BrowserPicture t={t} />

      <ul className="qs-facts">
        <li>
          <PopIcon name="magnifying-glass" tone="purple" size={22} />
          <span>
            <strong>{t.resultsLabel}</strong> <span className="qs-chip">{t.chip}</span> {t.resultsRest}
          </span>
        </li>
        <li>
          <PopIcon name="storefront" tone="blue" size={22} />
          <span>
            <strong>{t.otherLabel}</strong> {t.otherRest}
          </span>
        </li>
        <li>
          <PopIcon name="lock-key" tone="green" size={22} />
          <span>
            <strong>{t.choiceLabel}</strong> {t.choiceRest} <Link href="/privacy#extension">{t.shared}</Link>
          </span>
        </li>
      </ul>

      <section className="qs-install" id="install">
        <h2>{t.install}</h2>
        <p className="hint">{t.soon}</p>
        <ol>
          <li>
            {t.step1a}{" "}
            <a href="https://github.com/yc82628/sigpath" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>{" "}
            {t.step1b}
          </li>
          <li>
            {t.step2a} <code>chrome://extensions</code>
            {t.step2b}
          </li>
          <li>
            {t.step3a} <code>extension</code> {t.step3b}
          </li>
        </ol>
      </section>
    </main>
  );
}
