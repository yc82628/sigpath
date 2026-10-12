import Link from "next/link";
import PopIcon from "../components/PopIcon";
import type { IconName } from "../components/icon-paths";

/**
 * app/extension — a quick start for the SigPath browser extension (extension/):
 * three steps and a picture of it at work, rather than paragraphs. The details
 * are in the privacy notice. The extension opens this page when installed.
 */

export const metadata = { title: "The SigPath extension — SigPath" };

const STEPS: { icon: IconName; tone: "purple" | "blue" | "green"; title: string; line: string }[] = [
  { icon: "plus", tone: "purple", title: "Add it", line: "To Chrome or Edge, once." },
  { icon: "shopping-cart-simple", tone: "blue", title: "Shop as usual", line: "Amazon, AliExpress, OTTO, MediaMarkt, Saturn." },
  { icon: "seal-check", tone: "green", title: "See the check", line: "Price vs eBay, red flags, the best deal." },
];

/** The extension at work on a product page: a drawing, not a screenshot of any real listing. */
function BrowserPicture() {
  return (
    <figure className="qs-browser" aria-label="The SigPath panel on an Amazon product page">
      <div className="qs-bar" aria-hidden="true">
        <span className="qs-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="qs-url">amazon.de/…/dp/B0…</span>
        <span className="qs-ext" title="The extension's icon shows the verdict">
          ✓
        </span>
      </div>
      <div className="qs-page" aria-hidden="true">
        <div className="qs-product">
          <div className="qs-photo">
            <PopIcon name="headphones" tone="blue" size={56} />
          </div>
          <div className="qs-lines">
            <b>Wireless earbuds, 2nd gen</b>
            <span className="qs-price">229,00 €</span>
            <span className="qs-line" />
            <span className="qs-line short" />
            <span className="qs-buy">Add to basket</span>
          </div>
        </div>
        <div className="qs-panel">
          <span className="qs-brand">SigPath</span>
          <span className="qs-pill">✓ Checked</span>
          <span>
            <b>4 % below</b> eBay&apos;s typical price
          </span>
          <span className="qs-muted">Best checked eBay deal: 205 €</span>
          <span className="qs-muted">Sold by: Amazon</span>
        </div>
      </div>
      <figcaption>On every product page: the check appears at the bottom right.</figcaption>
    </figure>
  );
}

export default function ExtensionPage() {
  return (
    <main className="container quick-start">
      <h1>The SigPath extension</h1>
      <p className="lede">SigPath&apos;s check, right on the shop&apos;s page.</p>

      <ol className="qs-steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="qs-num">{i + 1}</span>
            <PopIcon name={s.icon} tone={s.tone} size={30} />
            <strong>{s.title}</strong>
            <span>{s.line}</span>
          </li>
        ))}
      </ol>

      <BrowserPicture />

      <ul className="qs-facts">
        <li>
          <PopIcon name="magnifying-glass" tone="purple" size={22} />
          <span>
            <strong>On Amazon&apos;s results:</strong> <span className="qs-chip">Check with SigPath →</span> under every price.
          </span>
        </li>
        <li>
          <PopIcon name="storefront" tone="blue" size={22} />
          <span>
            <strong>Any other shop:</strong> click the icon, then &ldquo;Check this page&rdquo;.
          </span>
        </li>
        <li>
          <PopIcon name="lock-key" tone="green" size={22} />
          <span>
            <strong>Your choice:</strong> sharing Amazon prices is off until you turn it on.{" "}
            <Link href="/privacy#extension">What&apos;s shared</Link>
          </span>
        </li>
      </ul>

      <section className="qs-install" id="install">
        <h2>Install it</h2>
        <p className="hint">In the Chrome Web Store soon. Until then:</p>
        <ol>
          <li>
            Download SigPath from{" "}
            <a href="https://github.com/yc82628/sigpath" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>{" "}
            (Code → Download ZIP), unzip it.
          </li>
          <li>
            Open <code>chrome://extensions</code>, turn on Developer mode.
          </li>
          <li>
            &ldquo;Load unpacked&rdquo; → the <code>extension</code> folder.
          </li>
        </ol>
      </section>
    </main>
  );
}
