import Link from "next/link";
import type { CSSProperties } from "react";
import { headers } from "next/headers";
import { checkPrice, parsePrice, SHOPS, type Market } from "@/lib/marketplace/price-check";
import { type Money } from "@/lib/marketplace/types";
import { moneyText } from "@/lib/i18n/money";
import { limitedMessage, RULES } from "@/lib/guard/limit";
import PopIcon from "../components/PopIcon";
import { getLang } from "@/lib/i18n/server";
import { MESSAGES, type Messages } from "@/lib/i18n/messages";
import { translateCheck } from "@/lib/i18n/checks";
import { count } from "@/lib/stats/counter";
import { checkDiscount, type DiscountCheck } from "@/lib/marketplace/discount";
import { readHistory, recordMarket, summarize, type HistorySummary } from "@/lib/marketplace/history";
import PriceHistory from "../components/PriceHistory";

/**
 * app/check — check a price from any shop (Amazon, AliExpress, anywhere)
 * against live eBay listings of the same product. See
 * lib/marketplace/price-check.ts. The shopper brings the title and price, typed
 * in or read from the page they're on by the "SigPath check" bookmark below.
 *
 * The answer reads top to bottom, plainest first: one word and one sentence
 * anyone can follow ("Good price: that's 27 € less than it usually costs"),
 * then a ruler showing where the price sits, the warnings, cheaper checked
 * offers, and last, folded away, the numbers behind it for sellers and shops.
 */

// The browser tab in the page's language, as the page.
export function generateMetadata() {
  return { title: getLang() === "de" ? "Preis prüfen — SigPath" : "Check a price — SigPath" };
}
export const dynamic = "force-dynamic";

/** Runs on the shop's page, in the shopper's own browser: reads the title and price shown, opens SigPath. */
function bookmarklet(origin: string): string {
  const code = `(function(){var d=document,q=function(s){return d.querySelector(s)};var te=q('#productTitle')||q('h1[data-pl="product-title"]')||q('h1');var t=(te&&te.innerText||d.title||'').trim();var sel=['#corePrice_feature_div .a-offscreen','#corePriceDisplay_desktop_feature_div .a-offscreen','span.a-price .a-offscreen','#priceblock_ourprice','#priceblock_dealprice','.product-price-current','[class*="price--current"]','[class*="price-default--current"]','[itemprop=price]','meta[property="product:price:amount"]'];var p='';for(var i=0;i<sel.length&&!p;i++){var e=q(sel[i]);var v=e&&(e.getAttribute('content')||e.innerText||e.textContent);if(v&&/\\d/.test(v))p=v.trim();}if(!p){var ls=d.querySelectorAll('script[type="application/ld+json"]');for(var k=0;k<ls.length&&!p;k++){try{var j=JSON.parse(ls[k].textContent);var a=[].concat(j['@graph']||j);for(var m=0;m<a.length&&!p;m++){var o=a[m].offers&&[].concat(a[m].offers)[0];if(o&&o.price)p=o.price+' '+(o.priceCurrency||'');}}catch(x){}}}var we=q('#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen')||q('.a-text-price[data-a-strike="true"] .a-offscreen');var w=(we&&we.textContent||'').trim();var h=location.hostname,f=/amazon\\./.test(h)?'amazon':/aliexpress\\./.test(h)?'aliexpress':'other';window.open(${JSON.stringify(origin)}+'/check?'+new URLSearchParams({title:t.slice(0,300),price:p,was:/\\d/.test(w)?w:'',from:f,url:location.origin+location.pathname}),'_blank');})();`;
  return "javascript:" + encodeURIComponent(code);
}

type Result = NonNullable<Awaited<ReturnType<typeof checkPrice>>>;

/**
 * The answer in one word. A deal label only for a price SigPath checked (as on
 * the search page); a warning always wins; no comparison, no label.
 */
type Tone = "good" | "fair" | "high" | "caution" | "ok" | "unknown";
function toneOf(r: Result): Tone {
  const verdict = r.product.check.verdict;
  if (verdict === "caution") return "caution";
  if (verdict === "checked") return r.deal ? r.deal.tone : "ok";
  return "unknown";
}

const GLYPH: Record<Tone, string> = { good: "✓", fair: "=", high: "↑", caution: "!", ok: "✓", unknown: "?" };

export default async function CheckPage({ searchParams }: { searchParams: { title?: string; price?: string; was?: string; from?: string; url?: string } }) {
  const h = headers();
  const lang = getLang();
  const m = MESSAGES[lang];
  const t = m.check;
  const tc = (s: string) => translateCheck(s, lang);
  const money = (x: Money) => moneyText(x, lang);
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const title = (searchParams.title ?? "").trim().slice(0, 300);
  const priceText = (searchParams.price ?? "").trim().slice(0, 40);
  const from = (searchParams.from && searchParams.from in SHOPS ? searchParams.from : "other") as keyof typeof SHOPS;
  const url = /^https:\/\//.test(searchParams.url ?? "") ? searchParams.url!.slice(0, 500) : undefined;
  const price = priceText ? parsePrice(priceText) : null;
  const asked = !!(title || priceText);
  // A check is an eBay search too, against the same daily quota.
  const tooMany = title && price && (await limitedMessage(h, RULES.search)) ? m.search.tooMany : null;
  const result = title && price && !tooMany ? await checkPrice({ title, price, from, url }) : null;
  if (result) await count(["check"], { userAgent: h.get("user-agent") });
  // The product's days on eBay (history.ts): today's typical new price noted, the last 30 read.
  let history: HistorySummary | null = null;
  if (result) {
    const cur = result.product.price.currency;
    const [, days] = await Promise.all([
      recordMarket(result.query, { n: result.market?.basis === "new" ? result.market.typical : null, currency: cur }),
      readHistory(result.query),
    ]);
    history = summarize(days, "new", cur);
  }
  // The struck-out price, when the shopper (or the bookmark) gave one: is the advertised discount real? (discount.ts)
  const wasText = (searchParams.was ?? "").trim().slice(0, 40);
  const was = wasText ? parsePrice(wasText) : null;
  const discount =
    result && price && was && was.currency === price.currency
      ? checkDiscount({
          price: price.amount,
          was: was.amount,
          market: result.market ? { typical: result.market.typical, high: result.market.high } : null,
          checked: result.product.check.verdict === "checked",
        })
      : null;
  const example = `/check?${new URLSearchParams({ title: "Sony WH-1000XM5", price: "279,00 €", from: "amazon" })}`;

  return (
    <main className="container check-page">
      <h1>{t.title}</h1>
      <p className="lede">{t.lede}</p>

      {asked && !result && (
        <p className="notice withheld">
          {tooMany ?? (!title ? t.addName : t.badPrice(priceText))}
        </p>
      )}

      {result && <Answer r={result} t={t} tc={tc} money={money} discount={discount} history={history} m={m} lang={lang} />}

      <form className="supplier-form check-form" action="/check" method="get">
        {result && <h2>{t.again}</h2>}
        <label>
          <span>
            {t.name} <span className="hint">({t.nameHint})</span>
          </span>
          <input name="title" defaultValue={title} placeholder="Apple AirPods Pro 2" required />
        </label>
        <div className="check-form-row">
          <label>
            {t.price}
            <input name="price" defaultValue={priceText} placeholder="249,00 €" required inputMode="decimal" />
          </label>
          <label>
            <span>
              {t.wasField} <span className="hint">({t.wasHint})</span>
            </span>
            <input name="was" defaultValue={wasText} placeholder="299,00 €" inputMode="decimal" />
          </label>
          <label>
            {t.shop}
            <select name="from" defaultValue={from}>
              <option value="amazon">Amazon</option>
              <option value="aliexpress">AliExpress</option>
              <option value="other">{t.another}</option>
            </select>
          </label>
        </div>
        {url && <input type="hidden" name="url" value={url} />}
        <button type="submit" className="primary">
          {t.button}
        </button>
        {!result && (
          <p className="hint">
            {t.example} <Link href={example}>{t.exampleLink}</Link>
          </p>
        )}
      </form>

      <section className="guarantees check-faster">
        <h2 className="with-icon">
          <PopIcon name="storefront" tone="green" size={24} />
          {t.faster}
        </h2>
        <p>
          {t.extension} <Link href="/extension">{t.extensionLink}</Link>
        </p>
        <details>
          <summary>{t.bookmark}</summary>
          <p>
            {t.drag}{" "}
            <span
              dangerouslySetInnerHTML={{
                __html: `<a class="button" href="${bookmarklet(origin).replace(/"/g, "&quot;")}" title="${t.dragTitle}">SigPath check</a>`,
              }}
            />
          </p>
          <p className="hint">{t.thenClick}</p>
        </details>
      </section>
    </main>
  );
}

type T = Messages["check"];

function Answer({
  r,
  t,
  tc,
  money,
  discount,
  history,
  m,
  lang,
}: {
  r: Result;
  t: T;
  tc: (s: string) => string;
  money: (x: Money) => string;
  discount: DiscountCheck | null;
  history: HistorySummary | null;
  m: Messages;
  lang: "en" | "de";
}) {
  const tone = toneOf(r);
  const cur = r.product.price.currency;
  const at = (amount: number) => money({ amount, currency: cur });
  const price = r.product.price.amount;
  // The usual price: the market's (same condition) when there is one, else the whole comparison's median.
  const typical = r.market?.typical ?? r.comparison?.median ?? null;
  const gap = typical === null ? 0 : price - typical;
  // With a market, the answer above says the price against it in its own numbers; the search's own
  // comparison line (another count, the shop's price included) would only contradict them.
  const points = r.product.check.points.filter((p) => !(r.market && p.about === "price"));
  const warns = points.filter((p) => p.tone === "warn");
  const goods = points.filter((p) => p.tone === "good");

  const say =
    tone === "good"
      ? t.say.good(at(Math.abs(gap)))
      : tone === "high"
        ? t.say.high(at(Math.abs(gap)))
        : tone === "fair"
          ? gap === 0
            ? t.say.exact
            : t.say.fair(at(Math.abs(gap)), gap < 0)
          : tone === "caution"
            ? t.say.caution
            : tone === "ok"
              ? typical !== null
                ? t.say.okTypical(at(typical))
                : t.say.ok
              : // Not compared: the reason as the check gives it ("There weren't enough new listings…").
                points[0]?.tone === "info"
                ? tc(points[0].text)
                : t.say.unknown;

  const cheaper = r.bestEbay.filter((d) => d.total.amount < price);

  return (
    <div className="check-answer" aria-live="polite">
      <section className={`answer-card ${tone}`}>
        <p className="answer-found">
          {t.found(t.shopNames[r.shop] ?? r.shop)}
        </p>
        <h2 className="answer-product">{r.product.title}</h2>
        <div className="answer-main">
          <span className="answer-glyph" aria-hidden="true">
            {GLYPH[tone]}
          </span>
          <div className="answer-words">
            <p className="answer-verdict">{t.verdict[tone]}</p>
            <p className="answer-say">{say}</p>
          </div>
          <p className="answer-price">
            {money(r.product.price)}
            {r.deal && <span className={`deal-chip ${r.deal.tone}`}>{t.pct(r.deal.pct)}</span>}
          </p>
        </div>
      </section>

      {r.ebay.status !== "ok" && <p className="notice withheld">{t.ebayDown}</p>}

      {discount && <DiscountBox d={discount} t={t} at={at} />}

      {r.market && <PriceRuler market={r.market} price={price} tone={tone} t={t} at={at} />}

      {history && (
        <section className="answer-box">
          <PriceHistory h={history} t={m.history} lang={lang} money={at} price={price} />
        </section>
      )}

      {(warns.length > 0 || goods.length > 0 || tone === "ok" || tone === "good" || tone === "fair" || tone === "high") && (
        <section className="answer-box">
          <h3>{t.why}</h3>
          <ul className="answer-checks">
            {warns.map((p, i) => (
              <li key={`w${i}`} className="warn">
                {tc(p.text)}
              </li>
            ))}
            {goods.map((p, i) => (
              <li key={`g${i}`} className="good">
                {tc(p.text)}
              </li>
            ))}
            {!warns.length && !goods.length && <li className="good">{t.allFine}</li>}
          </ul>
        </section>
      )}

      {r.bestEbay.length > 0 && (
        <section className="answer-box">
          <h3>{t.better(cheaper.length > 0)}</h3>
          <div className="offers">
            {r.bestEbay.map((d) => (
              <article key={d.listing.id} className="offer">
                <div className="thumb" aria-hidden="true">
                  {d.listing.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.listing.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    "e"
                  )}
                </div>
                <div className="offer-body">
                  <p className="offer-price">
                    {money(d.total)} <span className="chip">{m.listing.conditions[d.group] ?? d.group}</span>
                    {d.total.amount < price && <span className="deal-chip good">{t.less(at(price - d.total.amount))}</span>}
                  </p>
                  <p className="offer-title">{d.listing.title}</p>
                  <a
                    className="button ghost offer-go"
                    href={d.listing.url}
                    target="_blank"
                    rel={d.listing.affiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}
                  >
                    {t.onEbay}
                  </a>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {r.elsewhere && (
        <section className="answer-box">
          <h3>{t.alsoOn}</h3>
          <article className="offer">
            <div className="thumb" aria-hidden="true">
              {r.elsewhere.listing.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.elsewhere.listing.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                "A"
              )}
            </div>
            <div className="offer-body">
              <p className="offer-price">{money(r.elsewhere.total)}</p>
              <p className="offer-title">{r.elsewhere.listing.title}</p>
              <p className="hint">{t.alsoNote}</p>
              <a
                className="button ghost offer-go"
                href={r.elsewhere.listing.url}
                target="_blank"
                rel={r.elsewhere.listing.affiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}
              >
                {t.onAli}
              </a>
            </div>
          </article>
        </section>
      )}

      <p className="hint">{t.wrong}</p>

      <Numbers r={r} t={t} tc={tc} at={at} typical={typical} gap={gap} />
    </div>
  );
}

/** Is the advertised discount real? Against the market, and the 30-day low the law asks for (discount.ts). */
function DiscountBox({ d, t, at }: { d: DiscountCheck; t: T; at: (n: number) => string }) {
  const x = t.discount;
  const warn = d.verdict === "inflated" || d.verdict === "not-lower";
  const line =
    d.verdict === "inflated"
      ? x.inflated(d.claimedPct, at(d.was), x.ref[d.reference] ?? x.ref.unknown, d.vsMarketPct ?? 0, at(d.typical ?? 0))
      : d.verdict === "not-lower"
        ? x.notLower(at(d.lowest30 ?? 0))
        : d.verdict === "real"
          ? x.real(d.claimedPct, d.vsMarketPct ?? 0)
          : x.unchecked(d.claimedPct);
  return (
    <section className={`answer-box discount-box${warn ? " warn" : d.verdict === "real" ? " good" : ""}`}>
      <h3>{x.title}</h3>
      <ul className="answer-checks">
        <li className={warn ? "warn" : d.verdict === "real" ? "good" : ""}>{line}</li>
      </ul>
      <p className="hint">{x.rule}</p>
    </section>
  );
}

/**
 * Where the price sits: a bar from cheaper to more expensive, the usual range
 * shaded, the usual price and this price marked. Labels at the ends of the bar
 * hold to its edges so they never run off a phone screen.
 */
function PriceRuler({ market, price, tone, t, at }: { market: Market; price: number; tone: Tone; t: T; at: (n: number) => string }) {
  const lo = Math.min(market.low, price);
  const hi = Math.max(market.high, price);
  const span = hi - lo || market.typical * 0.2 || 1;
  const min = lo - span * 0.15;
  const max = hi + span * 0.15;
  const pos = (x: number) => ((x - min) / (max - min)) * 100;
  const place = (x: number): CSSProperties => {
    const p = pos(x);
    return { left: `${p.toFixed(1)}%`, transform: p < 14 ? "none" : p > 86 ? "translateX(-100%)" : "translateX(-50%)" };
  };
  return (
    <section className="answer-box">
      <h3>{t.ruler.title}</h3>
      <div className="ruler" role="img" aria-label={t.ruler.aria(at(price), at(market.low), at(market.high))}>
        <span className={`ruler-label here ${tone}`} style={place(price)}>
          <b>{t.ruler.here}</b> {at(price)}
        </span>
        <div className="ruler-track">
          <span className="ruler-band" style={{ left: `${pos(market.low)}%`, width: `${pos(market.high) - pos(market.low)}%` }} />
          <span className="ruler-tick" style={{ left: `${pos(market.typical)}%` }} />
          <span className={`ruler-dot ${tone}`} style={{ left: `${pos(price)}%` }} />
        </div>
        <span className="ruler-label usual" style={place(market.typical)}>
          <b>{t.ruler.usual}</b> {at(market.typical)}
        </span>
      </div>
      <p className="ruler-ends" aria-hidden="true">
        <span>← {t.ruler.cheaper}</span>
        <span>{t.ruler.dearer} →</span>
      </p>
      <p className="hint">
        {t.ruler.most(at(market.low), at(market.high))} {t.ruler.based(market.count, t.basis[market.basis] ?? market.basis)}
      </p>
    </section>
  );
}

/** The numbers behind the answer, folded away: what a seller or shop needs to see how the price was judged. */
function Numbers({
  r,
  t,
  tc,
  at,
  typical,
  gap,
}: {
  r: Result;
  t: T;
  tc: (s: string) => string;
  at: (n: number) => string;
  typical: number | null;
  gap: number;
}) {
  const n = t.numbers;
  const pct = typical ? Math.round((gap / typical) * 100) : null;
  return (
    <details className="answer-numbers">
      <summary>{n.title}</summary>
      <dl>
        {(r.market || r.comparison) && (
          <>
            <dt>{n.compared}</dt>
            <dd>{r.market ? n.comparedMarket(r.market.count, t.basis[r.market.basis] ?? r.market.basis) : n.comparedAll(r.comparison!.sampleSize)}</dd>
          </>
        )}
        {typical !== null && (
          <>
            <dt>{n.typical}</dt>
            <dd>{at(typical)}</dd>
          </>
        )}
        {r.market && (
          <>
            <dt>{n.range}</dt>
            <dd>
              {at(r.market.low)} – {at(r.market.high)} <span className="hint">({n.rangeNote(r.market.count)})</span>
            </dd>
          </>
        )}
        {pct !== null && (
          <>
            <dt>{n.gap}</dt>
            <dd>
              {t.pct(r.deal?.pct ?? pct)} ({gap > 0 ? "+" : gap < 0 ? "−" : "±"}
              {at(Math.abs(gap))})
            </dd>
          </>
        )}
        <dt>{n.rule}</dt>
        <dd>{n.ruleText}</dd>
        <dt>{n.search}</dt>
        <dd>
          {n.searchValue(r.query, r.ebay.count)} · <Link href={`/search?q=${encodeURIComponent(r.query)}`}>{n.seeAll}</Link>
        </dd>
        <dt>{n.notes}</dt>
        <dd>
          <ul className="answer-checks small">
            {r.product.check.points.filter((p) => !(r.market && p.about === "price")).map((p, i) => (
              <li key={i} className={p.tone}>
                {tc(p.text)}
              </li>
            ))}
          </ul>
        </dd>
      </dl>
      <p>
        <Link href="/how">{n.how}</Link>
      </p>
    </details>
  );
}
