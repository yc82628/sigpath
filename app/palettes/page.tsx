/**
 * app/palettes — the live palette and the previous one, side by side, on real components.
 *
 * A design-review page, not linked from the site. Each panel sets a theme
 * class that redefines the colour tokens (see the end of globals.css), so what
 * renders here is exactly what the site would look like.
 */

export const metadata = { title: "Palette comparison — SigPath" };

const THEMES = [
  {
    cls: "theme-cyan",
    name: "Logo Cyan",
    blurb: "The logo's cyan and black. Bold and bright, with black buttons wearing the cyan.",
    swatches: [
      ["#3ec1d3", "logo cyan"],
      ["#111111", "logo black"],
      ["#0a6774", "text accent"],
      ["#f2f8f9", "page"],
      ["#4b585b", "muted"],
      ["#22703d", "checked"],
      ["#8e5a14", "look closer"],
    ],
  },
  {
    cls: "theme-sage",
    name: "Sage & Brass",
    blurb: "Sage, teal and brass on sand. Warm and natural, with a touch of gold.",
    swatches: [
      ["#46685f", "brand"],
      ["#f6f3ec", "page"],
      ["#fcfbf8", "card"],
      ["#2a2725", "text"],
      ["#67625f", "muted"],
      ["#22703d", "checked"],
      ["#8e5a14", "look closer"],
    ],
  },
] as const;

function Preview() {
  return (
    <>
      <div className="mini-hero">
        <p className="eyebrow">eBay &middot; Amazon &middot; Etsy &middot; one search</p>
        <h3 className="hero-title">
          Every deal compared.
          <br />
          <span className="hero-accent">Every deal checked.</span>
        </h3>
        <div className="searchbar" style={{ margin: "0 auto", maxWidth: 420 }}>
          <input placeholder="What are you looking for?" readOnly aria-label="Search (preview)" />
          <button type="button">Search</button>
        </div>
      </div>

      <section className="best-deals">
        <h2>Best checked deal</h2>
        <span className="deal-price">356.00 EUR</span> <span className="chip">eBay</span> <span className="hint">new</span>
        <br />
        <a href="#preview">Lenovo ThinkPad X1 Carbon Gen 11</a>
        <span className="saving"> &mdash; 61.00 EUR below the typical new price</span>
        <br />
        <button type="button" className="alert-open">
          &#128276; Alert me if it drops
        </button>
      </section>

      <article className="listing">
        <div className="thumb" aria-hidden="true">
          e
        </div>
        <div className="body">
          <h3>
            <a href="#preview">ThinkPad X1 Carbon, sealed</a>
          </h3>
          <p className="meta">
            <span className="chip">eBay</span> new &middot; techdeals_de <span className="verified">&#10003; Verified seller</span>
          </p>
          <div className="check-label checked">
            <span className="check-head">&#10003; SigPath-checked</span>
            <ul>
              <li className="good">Price in line with the market: compared across 19 new listings.</li>
              <li className="good">No warnings about this seller or its photos.</li>
            </ul>
          </div>
          <a className="pay" href="#preview">
            Pay with USDC &rarr;
          </a>
        </div>
        <div className="price">
          359.00 EUR<span className="ship">free shipping</span>
        </div>
      </article>

      <article className="listing">
        <div className="thumb" aria-hidden="true">
          a
        </div>
        <div className="body">
          <h3>
            <a href="#preview">ThinkPad X1 — URGENT SALE, must go today</a>
          </h3>
          <p className="meta">
            <span className="chip">Amazon</span> new &middot; quick_deals
          </p>
          <div className="check-label caution">
            <span className="check-head">! Look closer</span>
            <ul>
              <li className="warn">This photo appears on 2 different seller accounts on the same marketplace.</li>
              <li className="warn">Priced well below the 19-listing median.</li>
            </ul>
          </div>
        </div>
        <div className="price">
          124.00 EUR<span className="ship">free shipping</span>
        </div>
      </article>

      <article className="listing">
        <div className="thumb" aria-hidden="true">
          E
        </div>
        <div className="body">
          <h3>
            <a href="#preview">Hand-stitched laptop sleeve</a>
          </h3>
          <p className="meta">
            <span className="chip">Etsy</span> new &middot; StitchWorks
          </p>
          <div className="check-label unchecked">
            <span className="check-head">Not price-checked</span>
            <ul>
              <li className="info">Prices from this marketplace aren&apos;t compared with retail.</li>
            </ul>
          </div>
        </div>
        <div className="price">
          42.00 EUR<span className="ship">incl. shipping</span>
        </div>
      </article>

      <p style={{ marginTop: 16 }}>
        <a className="button" href="#preview">
          Start comparing
        </a>{" "}
        <a className="button ghost" href="#preview">
          Your price alerts
        </a>
      </p>
    </>
  );
}

export default function PalettesPage() {
  return (
    <main className="container palette-page" id="preview">
      <h1>Palette comparison</h1>
      <p className="lede">
        The same components in the live palette and the one it replaced. Logo Cyan takes its colours straight from the
        logo; text accents use a deeper cyan so they stay readable.
      </p>
      <p className="notice">
        <strong>Logo Cyan is live</strong> across the site (with the finalised logo, 2026-10-02), with a matching dark
        mode. Sage &amp; Brass is kept here for comparison.
      </p>
      <div className="palette-compare">
        {THEMES.map((t) => (
          <section key={t.cls} className={`palette-panel ${t.cls}`}>
            <header>
              <h2>{t.name}</h2>
              <span className="hint">{t.blurb}</span>
            </header>
            <div className="palette-body">
              <ul className="swatches">
                {t.swatches.map(([hex, label]) => (
                  <li key={label}>
                    <span style={{ background: hex }} />
                    {label}
                    <br />
                    <code style={{ fontSize: "0.65rem", padding: 0, border: 0, background: "none" }}>{hex}</code>
                  </li>
                ))}
              </ul>
              <Preview />
            </div>
          </section>
        ))}
      </div>
      <section className="guarantees">
        <h2>Both palettes</h2>
        <ul>
          <li>
            <strong>Readable:</strong> every text colour clears WCAG AA (4.5:1) against its background.
          </li>
          <li>
            <strong>Green and amber stay as verdicts.</strong> They mean &ldquo;checked&rdquo; and &ldquo;look closer&rdquo;
            in both palettes, and the brand colour is kept visibly different from them: a green brand button next to a green
            &ldquo;checked&rdquo; pill would blur what the pill means.
          </li>
        </ul>
      </section>
    </main>
  );
}
