import Link from "next/link";

/**
 * app/extension — the SigPath browser extension (extension/): what it does,
 * what it shares, and how to install it. The extension opens this page when
 * it is first installed.
 */

export const metadata = { title: "The SigPath extension — SigPath" };

export default function ExtensionPage() {
  return (
    <main className="container">
      <h1>The SigPath extension</h1>
      <p className="lede">
        SigPath&apos;s check on the product page you&apos;re looking at: Amazon, AliExpress, OTTO, MediaMarkt and Saturn by
        itself, any other shop from the extension&apos;s menu.
      </p>

      <section className="guarantees">
        <h2>What it does</h2>
        <ul>
          <li>
            <strong>On a product page,</strong> a small SigPath panel at the bottom right: the price against eBay&apos;s
            typical price for the same item, SigPath&apos;s warnings, the best checked eBay deal, and on Amazon who sells
            it.
          </li>
          <li>
            <strong>On Amazon&apos;s search results,</strong> a &ldquo;Check with SigPath&rdquo; button under every result&apos;s
            price, opening SigPath&apos;s check for it.
          </li>
          <li>
            <strong>On any other shop,</strong> click the extension&apos;s icon and &ldquo;Check this page&rdquo;. The icon
            shows the verdict: ✓ checked, ! caution, ? not checked.
          </li>
          <li>
            <strong>On Amazon.de,</strong> if you turn on &ldquo;Share Amazon.de prices I see&rdquo;, the products and
            prices you see go into SigPath&apos;s search as &ldquo;seen on Amazon&rdquo;, so other shoppers can compare them. The
            product and its price only, never anything about you.
          </li>
        </ul>
      </section>

      <section className="guarantees">
        <h2>What it shares, and the switch</h2>
        <p>
          The switch is in the extension&apos;s menu (its icon in the toolbar), and it&apos;s off until you turn it on.
          Off, nothing is shared, and the check still works. The extension reads only the shop page you opened, and
          nothing about you is sent with it. The full detail is in the <Link href="/privacy#extension">privacy notice</Link>.
        </p>
      </section>

      <section className="guarantees">
        <h2>Install it (Chrome or Edge)</h2>
        <ol>
          <li>
            Download SigPath&apos;s code from{" "}
            <a href="https://github.com/yc82628/sigpath" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>{" "}
            (Code → Download ZIP) and unzip it.
          </li>
          <li>
            Open <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>) and switch on Developer mode.
          </li>
          <li>
            Click &ldquo;Load unpacked&rdquo; and choose the <code>extension</code> folder.
          </li>
          <li>Open any product on Amazon: the SigPath panel appears at the bottom right. Already had it installed? Click
            its reload arrow in the extensions page, then reload the Amazon page.</li>
        </ol>
        <p className="hint">It will be in the Chrome Web Store and Edge Add-ons once it&apos;s been reviewed there.</p>
      </section>
    </main>
  );
}
