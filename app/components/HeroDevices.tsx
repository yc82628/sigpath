import FluidTrail from "./FluidTrail";
import PopIcon, { type Tone } from "./PopIcon";
import type { IconName } from "./icon-paths";
import type { Lang } from "@/lib/i18n/lang";

/**
 * The home page's introduction: SigPath on a laptop and a phone.
 *
 * Both devices and both screens are drawn in HTML and CSS: no screenshots, no
 * downloads. The screen is a small SigPath search, played as a loop: the query
 * types itself, the results arrive one by one and their verdicts pop in. The
 * laptop turns slowly in 3D, the phone scrolls through the same search. With
 * "reduce motion" everything holds still on the finished search (globals.css).
 *
 * The rows are an illustration of the kinds of verdict SigPath gives, with
 * icons for photos: not listings from any marketplace, and the caption says so.
 */

type Verdict = "checked" | "caution" | "unchecked";
type Row = { icon: IconName; tone: Tone; title: string; market: string; verdict: Verdict; reason: string; price: string };

const COPY: Record<Lang, { query: string; title: string; searched: string; best: string; bestLine: string; verdict: Record<Verdict, string>; rows: Row[] }> = {
  en: {
    query: "AirPods Pro 2",
    title: "Compare every marketplace",
    searched: "searched",
    best: "Best checked deal",
    bestLine: "219.00 EUR · 31.00 EUR below the typical price",
    verdict: { checked: "✓ SigPath-checked", caution: "! Look closer", unchecked: "Not price-checked" },
    rows: [
      { icon: "headphones", tone: "blue", title: "AirPods Pro 2, USB-C, sealed", market: "eBay", verdict: "checked", reason: "In line with 14 identical listings", price: "219.00 EUR" },
      { icon: "headphones", tone: "purple", title: "AirPods Pro 2 – brand new!!", market: "eBay", verdict: "caution", reason: "Far below the market; account 3 days old", price: "89.00 EUR" },
      { icon: "gift", tone: "green", title: "Charging case for AirPods Pro 2", market: "AliExpress", verdict: "unchecked", reason: "An accessory, not the AirPods", price: "24.50 EUR" },
      { icon: "headphones", tone: "green", title: "AirPods Pro 2, used, like new", market: "eBay", verdict: "checked", reason: "In line with 9 used listings", price: "149.00 EUR" },
      { icon: "headphones", tone: "blue", title: "AirPods Pro 2 with MagSafe case", market: "eBay", verdict: "checked", reason: "Seller verified; price in line", price: "229.00 EUR" },
      { icon: "headphones", tone: "purple", title: "AirPods Pro 2 original, boxed", market: "eBay", verdict: "caution", reason: "Photo used by 3 other sellers", price: "119.00 EUR" },
    ],
  },
  de: {
    query: "AirPods Pro 2",
    title: "Alle Marktplätze vergleichen",
    searched: "durchsucht",
    best: "Bestes geprüftes Angebot",
    bestLine: "219,00 € · 31,00 € unter dem typischen Preis",
    verdict: { checked: "✓ Von SigPath geprüft", caution: "! Genauer hinsehen", unchecked: "Preis nicht geprüft" },
    rows: [
      { icon: "headphones", tone: "blue", title: "AirPods Pro 2, USB-C, versiegelt", market: "eBay", verdict: "checked", reason: "Im Rahmen von 14 identischen Angeboten", price: "219,00 €" },
      { icon: "headphones", tone: "purple", title: "AirPods Pro 2 – nagelneu!!", market: "eBay", verdict: "caution", reason: "Weit unter Markt; Konto 3 Tage alt", price: "89,00 €" },
      { icon: "gift", tone: "green", title: "Ladecase für AirPods Pro 2", market: "AliExpress", verdict: "unchecked", reason: "Zubehör, nicht die AirPods", price: "24,50 €" },
      { icon: "headphones", tone: "green", title: "AirPods Pro 2, gebraucht, wie neu", market: "eBay", verdict: "checked", reason: "Im Rahmen von 9 gebrauchten Angeboten", price: "149,00 €" },
      { icon: "headphones", tone: "blue", title: "AirPods Pro 2 mit MagSafe-Case", market: "eBay", verdict: "checked", reason: "Verkäufer verifiziert; Preis im Rahmen", price: "229,00 €" },
      { icon: "headphones", tone: "purple", title: "AirPods Pro 2 Original, OVP", market: "eBay", verdict: "caution", reason: "Foto von 3 anderen Verkäufern genutzt", price: "119,00 €" },
    ],
  },
};

/** The SigPath search inside a device's screen. `rows` limits how many results it shows. */
function Screen({ lang, rows, kind }: { lang: Lang; rows: number; kind: "laptop" | "phone" }) {
  const t = COPY[lang];
  return (
    <div className={`ds ds-${kind}`}>
      <div className="ds-bar">
        <span className="ds-logo">SIGPATH</span>
        <span className="ds-icons">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="ds-body">
        <b className="ds-h1">{t.title}</b>
        <div className="ds-search">
          <span className="ds-typed">{t.query}</span>
          <span className="ds-go" />
        </div>
        <div className="ds-chips">
          <span className="ds-chip">eBay · {t.searched}</span>
          <span className="ds-chip">AliExpress · {t.searched}</span>
        </div>
        <div className="ds-best">
          <span className="ds-best-label">{t.best}</span>
          <b>{t.bestLine}</b>
        </div>
        <ul className="ds-rows">
          {t.rows.slice(0, rows).map((r, i) => (
            <li key={r.title} className="ds-row" style={{ "--i": i } as React.CSSProperties}>
              <span className="ds-photo">
                <PopIcon name={r.icon} tone={r.tone} size={kind === "laptop" ? 22 : 18} onDark />
              </span>
              <span className="ds-text">
                <span className="ds-title">{r.title}</span>
                <span className="ds-meta">
                  <span className="ds-market">{r.market}</span> <span className={`ds-verdict ${r.verdict}`}>{t.verdict[r.verdict]}</span>
                </span>
                <span className="ds-reason">{r.reason}</span>
              </span>
              <span className="ds-price">{r.price}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function HeroDevices({ label, caption, lang }: { label: string; caption: string; lang: Lang }) {
  return (
    <figure className="devices" aria-label={label}>
      <div className="laptop" aria-hidden="true">
        <div className="laptop-body">
          <div className="laptop-lid">
            <span className="laptop-camera" />
            <div className="laptop-screen">
              <Screen lang={lang} rows={4} kind="laptop" />
            </div>
          </div>
          <div className="laptop-hinge" />
          <div className="laptop-base" />
        </div>
        <div className="laptop-shadow" />
      </div>
      <div className="phone" aria-hidden="true">
        <span className="phone-island" />
        <div className="phone-screen">
          <div className="phone-scroll">
            <Screen lang={lang} rows={6} kind="phone" />
          </div>
        </div>
      </div>
      <figcaption className="devices-caption">{caption}</figcaption>
    </figure>
  );
}

/**
 * Slow smoke behind the whole page: three soft clouds (CSS only), and with a
 * mouse, a smoke trail behind the cursor (FluidTrail).
 */
export function Smoke() {
  return (
    <div className="smoke" aria-hidden="true">
      <span className="smoke-a" />
      <span className="smoke-b" />
      <span className="smoke-c" />
      <FluidTrail />
    </div>
  );
}
