import Link from "next/link";
import { headers } from "next/headers";
import { checkPrice, parsePrice, SHOPS } from "@/lib/marketplace/price-check";
import { formatMoney } from "@/lib/marketplace/types";
import { limitedMessage, RULES } from "@/lib/guard/limit";

/**
 * app/check — check a price from any shop (Amazon, AliExpress, anywhere)
 * against live eBay listings of the same product. See
 * lib/marketplace/price-check.ts. The shopper brings the title and price, typed
 * in or read from the page they're on by the "SigPath check" bookmark below.
 */

export const metadata = { title: "Check a price — SigPath" };
export const dynamic = "force-dynamic";

/** Runs on the shop's page, in the shopper's own browser: reads the title and price shown, opens SigPath. */
function bookmarklet(origin: string): string {
  const code = `(function(){var d=document,q=function(s){return d.querySelector(s)};var te=q('#productTitle')||q('h1[data-pl="product-title"]')||q('h1');var t=(te&&te.innerText||d.title||'').trim();var sel=['#corePrice_feature_div .a-offscreen','#corePriceDisplay_desktop_feature_div .a-offscreen','span.a-price .a-offscreen','#priceblock_ourprice','#priceblock_dealprice','.product-price-current','[class*="price--current"]','[class*="price-default--current"]','[itemprop=price]','meta[property="product:price:amount"]'];var p='';for(var i=0;i<sel.length&&!p;i++){var e=q(sel[i]);var v=e&&(e.getAttribute('content')||e.innerText||e.textContent);if(v&&/\\d/.test(v))p=v.trim();}if(!p){var ls=d.querySelectorAll('script[type="application/ld+json"]');for(var k=0;k<ls.length&&!p;k++){try{var j=JSON.parse(ls[k].textContent);var a=[].concat(j['@graph']||j);for(var m=0;m<a.length&&!p;m++){var o=a[m].offers&&[].concat(a[m].offers)[0];if(o&&o.price)p=o.price+' '+(o.priceCurrency||'');}}catch(x){}}}var h=location.hostname,f=/amazon\\./.test(h)?'amazon':/aliexpress\\./.test(h)?'aliexpress':'other';window.open(${JSON.stringify(origin)}+'/check?'+new URLSearchParams({title:t.slice(0,300),price:p,from:f,url:location.origin+location.pathname}),'_blank');})();`;
  return "javascript:" + encodeURIComponent(code);
}

const pct = (a: number, b: number) => Math.round((Math.abs(a - b) / b) * 100);

export default async function CheckPage({ searchParams }: { searchParams: { title?: string; price?: string; from?: string; url?: string } }) {
  const h = headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const title = (searchParams.title ?? "").trim().slice(0, 300);
  const priceText = (searchParams.price ?? "").trim().slice(0, 40);
  const from = (searchParams.from && searchParams.from in SHOPS ? searchParams.from : "other") as keyof typeof SHOPS;
  const url = /^https:\/\//.test(searchParams.url ?? "") ? searchParams.url!.slice(0, 500) : undefined;
  const price = priceText ? parsePrice(priceText) : null;
  const asked = !!(title || priceText);
  // A check is an eBay search too, against the same daily quota.
  const tooMany = title && price ? await limitedMessage(h, RULES.search) : null;
  const result = title && price && !tooMany ? await checkPrice({ title, price, from, url }) : null;

  return (
    <main className="container">
      <h1>Check a price</h1>
      <p className="lede">
        Shopping on Amazon, AliExpress or anywhere else? SigPath compares the price with live eBay listings of the same
        product, and gives it the same verdict as a listing in its own search.
      </p>

      {asked && !result && (
        <p className="notice withheld">
          {tooMany ?? (!title ? "Add the product's name." : `"${priceText}" isn't a price SigPath can read. Type it like 249,00 € or 249.00.`)}
        </p>
      )}

      {result && (
        <section className="price-check" aria-live="polite">
          <h2>
            {result.shop}: {result.product.title}
          </h2>
          <p className="deal-price">{formatMoney(result.product.price)}</p>
          <div className={`check-label ${result.product.check.verdict}`}>
            <span className="check-head">
              {result.product.check.verdict === "checked" ? "✓ " : result.product.check.verdict === "caution" ? "! " : ""}
              {result.product.check.headline}
            </span>
            <ul>
              {result.product.check.points.map((p, i) => (
                <li key={i} className={p.tone}>
                  {p.text}
                </li>
              ))}
            </ul>
          </div>
          {result.comparison && (
            <p>
              The median price of the {result.comparison.sampleSize} identical listings is{" "}
              <strong>{formatMoney({ amount: result.comparison.median, currency: result.product.price.currency })}</strong>: this price
              is{" "}
              {result.product.price.amount === result.comparison.median
                ? "exactly that."
                : `${pct(result.product.price.amount, result.comparison.median)}% ${result.product.price.amount < result.comparison.median ? "lower" : "higher"}.`}
            </p>
          )}
          {result.ebay.status !== "ok" && <p className="notice withheld">eBay didn&apos;t answer just now, so there was nothing live to compare with. Try again in a moment.</p>}
          {result.bestEbay.length > 0 && (
            <>
              <h3>Best SigPath-checked deal{result.bestEbay.length > 1 ? "s" : ""} on eBay</h3>
              <ul>
                {result.bestEbay.map((d) => (
                  <li key={d.listing.id}>
                    <a href={d.listing.url} target="_blank" rel="noopener noreferrer">
                      {d.listing.title}
                    </a>{" "}
                    — {formatMoney(d.total)} ({d.group})
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="hint">
            Searched eBay for &ldquo;{result.query}&rdquo; ({result.ebay.count} listings). Not the right product? Edit the name
            below. The {result.shop} price is the one you brought: SigPath doesn&apos;t contact {result.shop}.{" "}
            <Link href={`/search?q=${encodeURIComponent(result.query)}`}>See all eBay results</Link>
          </p>
        </section>
      )}

      <form className="supplier-form" action="/check" method="get">
        <label>
          Product name
          <input name="title" defaultValue={title} placeholder="Apple AirPods Pro 2" required />
        </label>
        <label>
          Price
          <input name="price" defaultValue={priceText} placeholder="249,00 €" required />
        </label>
        <label>
          Shop
          <select name="from" defaultValue={from}>
            <option value="amazon">Amazon</option>
            <option value="aliexpress">AliExpress</option>
            <option value="other">Another shop</option>
          </select>
        </label>
        {url && <input type="hidden" name="url" value={url} />}
        <button type="submit" className="primary">
          Check this price
        </button>
      </form>

      <section className="guarantees">
        <h2>One click from the product page</h2>
        <p>
          Drag this button to your browser&apos;s bookmarks bar:{" "}
          <span
            dangerouslySetInnerHTML={{
              __html: `<a class="button" href="${bookmarklet(origin).replace(/"/g, "&quot;")}" title="Drag me to your bookmarks bar">SigPath check</a>`,
            }}
          />
        </p>
        <p>
          Then, on a product page on Amazon, AliExpress or most other shops, click it. It reads the product&apos;s name and
          price from the page you&apos;re looking at, in your own browser, and opens this check. Nothing else on the page is
          read, and nothing is sent to the shop.
        </p>
      </section>
    </main>
  );
}
