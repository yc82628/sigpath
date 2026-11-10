import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { looksLikeLink, queryFromLink } from "@/lib/marketplace/link-query";
import { limitedMessage, RULES } from "@/lib/guard/limit";
import { assembleSearch, startSearch } from "@/lib/marketplace/search";
import { defaultSources } from "@/lib/marketplace/sources";
import { cachedSources } from "@/lib/marketplace/search-cache";
import { count } from "@/lib/stats/counter";
import ClickCounter from "../components/ClickCounter";
import { totalPrice, type Listing, type Money, type SourceResult } from "@/lib/marketplace/types";
import { decimalText, moneyText } from "@/lib/i18n/money";
import type { Flag } from "@/lib/marketplace/anomaly";
import { signQuote, quoteSigningConfigured } from "@/lib/checkout/quote";
import { checkoutEligibility, priceCheckFor } from "@/lib/checkout/eligibility";
import { AddressStore } from "@/lib/checkout/address-store";
import { eurUsdRate, toUsdcBaseUnits } from "@/lib/checkout/fx";
import { formatFeeRate, serviceFeeBps, withServiceFee } from "@/lib/checkout/fee";
import { DecisionLog } from "@/lib/reports/reports";
import { VerifiedSellerLog, badgeFor, type BadgeView } from "@/lib/sellers/verified-log";
import { BusinessLog, businessIndex, verifiedPhotoFlags } from "@/lib/sellers/business";
import { listingKey, sellerKey } from "@/lib/marketplace/types";
import { checkedFirst, describeSaving, labelSearch, type BusinessBadge, type CheckLabel } from "@/lib/marketplace/label";
import AlertButton from "../components/AlertButton";
import AddToCart from "../components/AddToCart";
import PopIcon from "../components/PopIcon";
import { QUOTE_TTL_SECONDS } from "@/lib/checkout/quote";
import { getLang } from "@/lib/i18n/server";
import { MESSAGES } from "@/lib/i18n/messages";
import { translateCheck, translateWhere } from "@/lib/i18n/checks";
import { MARKETPLACES } from "@/lib/marketplace/registry";
import {
  activeCount,
  applyFilters,
  facets,
  filterHref,
  isFiltered,
  NO_FILTERS,
  parseFilters,
  type Facets,
  type FacetOption,
  type Filters,
} from "@/lib/marketplace/filters";
import AutoSubmit from "../components/AutoSubmit";
import { dealScore, dealTone, marketSnapshot, newMedianHasRefurbished, suggestNarrower, type MarketGroup } from "@/lib/marketplace/market";

const marketLabel = (id: string) =>
  MARKETPLACES.find((m) => m.id === id)?.label ?? (id === "stub" ? "Demo" : id === "feed" ? "Partner feeds" : id);

/**
 * app/search/page.tsx — the buyer-facing half.
 *
 * A SERVER COMPONENT WITH A PLAIN GET FORM, ON PURPOSE.
 * The query string is the entire state. That means: the page works with
 * JavaScript disabled, a result is a shareable URL, the back button does what
 * it should, and there is no client-side fetch to instrument. For a site whose
 * selling point is that it has no accounts, not shipping a tracking surface is
 * part of the product rather than an optimisation.
 *
 * Nothing here reads a cookie, a session or a user id, and the server writes no
 * log tying a query to a person.
 *
 * WHAT THE PAGE IS CAREFUL ABOUT
 * Every flag shown is an observation the buyer can weigh, never an accusation
 * about a seller — the styling is deliberately not alarm-red for the same
 * reason. And the coverage strip is not diagnostics: when a marketplace did not
 * answer, the price comparison is withheld and the page says so, because a
 * median taken over a biased sample would flag honest listings as suspicious.
 */

export const dynamic = "force-dynamic";

/** The page's strings, and check sentences, in the shopper's language (lib/i18n). */
function i18n() {
  const lang = getLang();
  return { m: MESSAGES[lang], tc: (t: string) => translateCheck(t, lang), lang };
}

/** A price in the shopper's language: "229.00 EUR", or "229,00 €" on German pages. */
const money = (x: Money) => moneyText(x, getLang());

/** Checkout offer for one listing: a signed quote, a reason there is none, or null when checkout is off. */
type CheckoutOffer = { token: string; usdc?: string } | { reason: string } | null;

/** "163.41 USDC": a preview rounded UP to the cent, so the checkout never shows more than this. */
function usdcPreview(baseUnits: bigint): string {
  return `${decimalText((Number((baseUnits + 9_999n) / 10_000n) / 100).toFixed(2), getLang())} USDC`;
}

function ListingRow({
  listing,
  flags,
  checkout,
  badge,
  business,
  label,
  deal = null,
}: {
  listing: Listing;
  flags: Flag[];
  checkout: CheckoutOffer;
  badge: BadgeView | null;
  business: BusinessBadge | null;
  label: CheckLabel;
  /** How far from the typical price of what it was compared with; checked listings only. */
  deal?: { pct: number; typical: Money } | null;
}) {
  const total = totalPrice(listing);
  const shipping = listing.shipping?.amount ?? 0;
  const seller = listing.seller;
  const warns = label.points.filter((p) => p.tone === "warn");
  const keyPoints = warns.length ? warns : label.points.slice(0, 1);
  const otherPoints = label.points.filter((p) => !keyPoints.includes(p));
  const { m, tc } = i18n();

  return (
    <article className="listing" id={`l-${listingKey(listing)}`}>
      <div className="thumb" aria-hidden="true">
        {listing.imageUrl ? (
          // The marketplace's own image, straight from its CDN. no-referrer: the
          // CDN learns an image was viewed, not which search on SigPath showed it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={listing.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          marketLabel(listing.source).slice(0, 1)
        )}
      </div>
      <div className="body">
        <h3>
          {/* noreferrer as well as noopener: the destination has no business
              knowing which search sent the buyer there. */}
          <a href={listing.url} target="_blank" rel={listing.affiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}>
            {listing.title}
          </a>
        </h3>
        <div className="price">
          {money(total)}
          {/* No shipping from the marketplace (AliExpress, Amazon sightings) is unknown shipping, not free shipping. */}
          <span className="ship">{!listing.shipping ? m.listing.plusShipping : shipping > 0 ? m.listing.inclShipping : m.listing.freeShipping}</span>
          {deal && (
            <span className={`deal-chip ${dealTone(deal.pct)}`} title={m.listing.dealTitle(money(deal.typical))}>
              {m.listing.deal(deal.pct)}
            </span>
          )}
        </div>
        <p className="meta">
          <span className="chip">{marketLabel(listing.source)}</span> {m.listing.conditions[listing.condition] ?? listing.condition} &middot;{" "}
          {/* A price a shopper saw, not a live one: says so where the seller would be. */}
          {listing.seenAt ? m.listing.seen(Math.floor((Date.now() - listing.seenAt) / 3_600_000)) : seller.displayName ?? seller.handle}
          {business ? (
            // The business tier: a VAT number checked against the EU register,
            // and every account its wallet verified. Like the seller badge, it
            // vouches for who runs the account, not the item.
            <>
              {" "}
              <a className="verified business" href={`/business/${encodeURIComponent(business.id)}`} title={m.listing.verifiedBusinessTitle}>
                {m.listing.verifiedBusiness}
              </a>
            </>
          ) : badge && (
            // Earned, not reported: the seller proved control of this account,
            // holds the non-transferable token, and passed a live check. It
            // vouches for the account, not the item — so it removes no flag
            // and changes nothing about the price check or checkout.
            <>
              {" "}
              <a
                className="verified"
                href={`/seller/${encodeURIComponent(listing.source)}/${encodeURIComponent(seller.handle)}`}
                title={m.listing.verifiedSellerTitle}
              >
                {m.listing.verifiedSeller}
              </a>
            </>
          )}
          {seller.feedbackScore !== undefined && (
            <>
              {" "}
              &middot;{" "}
              {/* The marketplace's own number, labelled for what it is. It is
                  self-contained to one platform and not independently
                  checkable — which is exactly the gap the verification half of
                  this product closes. Presenting it as trust would overstate
                  it. */}
              <span className="unverified" title={m.listing.ratingsTitle}>
                {m.listing.ratingsUnverified(seller.feedbackScore)}
              </span>
            </>
          )}
        </p>
        {/* One verdict per listing, every check underneath it. See lib/marketplace/label.ts. */}
        <div className={`check-label ${label.verdict}`}>
          <span className="check-head">
            {label.verdict === "checked" ? "✓ " : label.verdict === "caution" ? "! " : ""}
            {tc(label.headline)}
          </span>
          {/* The verdict, then only what matters: every red flag, or else the main reason. The rest folds away. */}
          <ul>
            {keyPoints.map((p, i) => (
              <li key={i} className={p.tone} title={tc(p.text)}>
                {tc(p.text)}
              </li>
            ))}
          </ul>
          {otherPoints.length > 0 && (
            <details className="check-more">
              <summary>{m.listing.howChecked}</summary>
              <ul>
                {otherPoints.map((p, i) => (
                  <li key={i} className={p.tone}>
                    {tc(p.text)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {checkout && "token" in checkout && (
          // The price travels inside a server signature, so this link cannot
          // be edited into a cheaper order. See lib/checkout/quote.ts.
          <a className="pay" href={`/checkout?quote=${encodeURIComponent(checkout.token)}`}>
            {m.listing.pay}{checkout.usdc && <span className="pay-amount"> · {checkout.usdc}</span>} &rarr;
          </a>
        )}
        {checkout && "reason" in checkout && label.verdict === "checked" && (
          // Unchecked or flagged: the verdict above already says why there's no pay button.
          <p className="pay-blocked">{tc(checkout.reason)}</p>
        )}
        {/* The cart keeps a snapshot in this browser and asks for the price again when opened (lib/cart/cart.ts). */}
        <AddToCart
          item={{
            key: listingKey(listing),
            source: listing.source,
            id: listing.id,
            title: listing.title,
            url: listing.url,
            imageUrl: listing.imageUrl,
            condition: listing.condition,
            seller: seller.displayName ?? seller.handle,
            price: listing.price,
            shipping: listing.shipping,
            verdict: label.verdict,
            headline: label.headline,
            quote:
              checkout && "token" in checkout
                ? { token: checkout.token, usdc: checkout.usdc, expiresAt: Date.now() + QUOTE_TTL_SECONDS * 1000 }
                : undefined,
          }}
        >
          <PopIcon name="shopping-cart-simple" tone="blue" size={18} />
        </AddToCart>
        {flags.some((f) => f.kind === "upheld_reports") && (
          // Every finding is shown with the seller's own reply beside it — a
          // buyer judging this seller should see both sides, not just ours.
          <p className="pay-blocked">
            <a href={`/seller/${encodeURIComponent(listing.source)}/${encodeURIComponent(seller.handle)}`}>
              {m.listing.findings}
            </a>
          </p>
        )}
      </div>
    </article>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  // A pasted product link: search for the product named in it (lib/marketplace/link-query.ts). The shop's page is
  // never fetched. A link with no name in it is said so, rather than searched for as text.
  const raw = (searchParams.q ?? "").trim().slice(0, 1000);
  const fromLink = looksLikeLink(raw) ? queryFromLink(raw) : null;
  if (fromLink) redirect(`/search?q=${encodeURIComponent(fromLink.query)}&link=${encodeURIComponent(fromLink.shop)}`);
  const unreadableLink = looksLikeLink(raw);
  const q = unreadableLink ? "" : raw.slice(0, 120);
  const linkShop = (searchParams.link ?? "").trim().slice(0, 40);
  const filters = parseFilters(searchParams);
  const checkedOnly = filters.checkedOnly;
  const { m } = i18n();
  // Public by design: browsers need it to subscribe. Alerts are offered only when it's set.
  const vapidKey = process.env.VAPID_PUBLIC_KEY?.trim() || null;

  // STREAMING. Every marketplace is asked NOW, once. The page shell goes out
  // immediately; each marketplace's listings stream in as it answers, marked
  // "checking"; and when the last one is in, the fully checked results replace
  // them. Verdicts are only ever drawn from the complete set — a price compared
  // against half the marketplaces is exactly the biased comparison this design
  // refuses — so nothing streamed early carries a verdict or a pay button.
  // Every search is an eBay call against the site's daily quota: a script gets a pause, not the quota.
  const tooMany = q && (await limitedMessage(headers(), RULES.search)) ? m.search.tooMany : null;
  // Kept three minutes (search-cache.ts): changing a filter re-asks nobody.
  const sources = q && !tooMany ? cachedSources(defaultSources()) : [];
  const pending = q && !tooMany ? startSearch(q, sources, { limit: 20 }) : [];
  // Counted once per search (lib/stats/counter.ts): a filter changed on the same results isn't another one.
  if (q && !tooMany && !isFiltered(filters)) await count(["search"], { userAgent: headers().get("user-agent") });

  return (
    <main className="container wide search-page">
      <h1>{m.search.title}</h1>
      <p className="lede">{m.search.lede}</p>

      <form className="searchbar" method="GET" action="/search">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={m.search.placeholder}
          aria-label={m.home.searchLabel}
          autoFocus
        />
        {checkedOnly && <input type="hidden" name="checked" value="1" />}
        <button type="submit">{m.home.searchButton}</button>
      </form>
      <p className="hint">{m.search.nothingStored}</p>
      {unreadableLink && <p className="notice withheld">{m.search.linkUnreadable}</p>}
      {q && linkShop && <p className="notice">{m.search.fromLink(linkShop)}</p>}

      {tooMany && <p className="notice withheld">{tooMany}</p>}
      {q && !tooMany && (
        <Suspense key={filterHref(q, filters)} fallback={<SearchProgress ids={sources.map((s) => s.id)} pending={pending} />}>
          <SearchResults q={q} filters={filters} vapidKey={vapidKey} pending={pending} />
        </Suspense>
      )}
      <ClickCounter />
    </main>
  );
}

/** While marketplaces are still answering: what has arrived so far, with no verdicts yet. */
function SearchProgress({ ids, pending }: { ids: string[]; pending: Promise<SourceResult>[] }) {
  const { m } = i18n();
  return (
    <section className="progress" aria-live="polite" aria-busy="true">
      <p className="notice">
        <span className="spinner" aria-hidden="true" /> {m.search.searching}
      </p>
      {ids.map((id, i) => (
        <Suspense
          key={id}
          fallback={
            <p className="progress-source">
              <span className="chip">{marketLabel(id)}</span> <span className="hint">{m.search.searchingSource}</span>
            </p>
          }
        >
          <SourceProgress result={pending[i]} />
        </Suspense>
      ))}
    </section>
  );
}

async function SourceProgress({ result }: { result: Promise<SourceResult> }) {
  const r = await result;
  // Not set up, or a snapshot with nothing in it (no Amazon prices shared yet): nothing to say about it.
  if (r.status === "not_configured" || (r.snapshot && r.status === "ok" && r.listings.length === 0)) return null;
  const { m } = i18n();
  if (r.status !== "ok") {
    return (
      <p className="progress-source">
        <span className="chip">{marketLabel(r.source)}</span> <span className="hint">{m.search.status[r.status] ?? r.status}</span>
      </p>
    );
  }
  return (
    <div className="progress-source">
      <p>
        <span className="chip">{marketLabel(r.source)}</span>{" "}
        <span className="hint">
          {m.search.listingsChecking(r.listings.length)}
        </span>
      </p>
      <div className="listing-grid">
      {[...r.listings]
        .sort((x, y) => totalPrice(x).amount - totalPrice(y).amount)
        .slice(0, 3)
        .map((l) => (
          <article key={listingKey(l)} className="listing provisional">
            <div className="thumb" aria-hidden="true">
              {l.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                marketLabel(l.source).slice(0, 1)
              )}
            </div>
            <div className="body">
              <h3>{l.title}</h3>
              <div className="price">{money(totalPrice(l))}</div>
              <div className="check-label pending">
                <span className="check-head">{m.search.searching}</span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/**
 * What the product costs right now (lib/marketplace/market.ts): per condition,
 * the typical price, the range most offers fall in, how many were compared,
 * and a small histogram of where the prices sit, the typical price marked.
 */
function MarketOverview({ groups, currency, query }: { groups: MarketGroup[]; currency: string; query: string }) {
  const { m } = i18n();
  if (!groups.length) return null;
  const at = (amount: number) => money({ amount, currency });
  return (
    <section className="market-now" aria-labelledby="market-title">
      <h2 id="market-title">{m.search.market.title}</h2>
      <div className="market-groups">
        {groups.map((g) => {
          const peak = Math.max(...g.bins);
          return (
            <div key={g.group} className="market-group">
              <span className="market-label">
                {g.group === "used" ? m.search.market.usedLabel : g.withRefurbished ? m.search.market.newRefurbishedLabel : m.search.market.newLabel}
              </span>
              <span className="market-typical">
                <b>{at(g.typical)}</b> {m.search.market.typical}
              </span>
              <span className="hint">
                {m.search.market.range(at(g.low), at(g.high))} · {m.search.market.offers(g.count)}
              </span>
              <div className="market-bars" role="img" aria-label={m.search.market.chart(at(g.min), at(g.max))}>
                {g.bins.map((n, i) => (
                  <i
                    key={i}
                    className={i === g.typicalBin ? "typical" : undefined}
                    style={{ height: `${Math.max(6, Math.round((n / peak) * 100))}%`, opacity: n ? 1 : 0.25 }}
                    title={i === g.typicalBin ? m.search.market.typicalMark : undefined}
                  />
                ))}
              </div>
              <span className="market-ends hint" aria-hidden="true">
                <span>{at(g.min)}</span>
                <span>{at(g.max)}</span>
              </span>
            </div>
          );
        })}
      </div>
      {suggestNarrower(groups, query) && <p className="hint market-wide">{m.search.market.wide}</p>}
    </section>
  );
}

/** "iPhone 15 Pro Max": the search's own words, then the model's, as people write them. */
function modelName(q: string, key: string): string {
  if (key === "base") return q;
  const word = (w: string) => (["se", "fe", "xl", "oled"].includes(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
  return `${q} ${key.split("-").map(word).join(" ")}`;
}

/**
 * The filters, in a column beside the results (a drawer behind a "Filter"
 * button on a phone), as a plain GET form: the choices land in the address, so
 * they can be shared and work without JavaScript (lib/marketplace/filters.ts).
 * Every choice says how many listings it would show.
 */
function FilterSidebar({ q, filters, fc }: { q: string; filters: Filters; fc: Facets }) {
  const { m } = i18n();
  const f = m.search.filters;
  const active = activeCount(filters);
  const eur = (cents: number | null) => (cents === null ? "" : String(cents / 100));
  const radios = <V extends string | number>(
    name: string,
    legend: string,
    current: V | null,
    options: FacetOption<V>[],
    label: (v: V) => string,
    anyCount?: number,
  ) => (
    <fieldset className="facet-group">
      <legend>{legend}</legend>
      <label className="facet">
        <input type="radio" name={name} value="" defaultChecked={current === null} />
        <span>{f.any}</span>
        {anyCount !== undefined && <span className="facet-n">{anyCount}</span>}
      </label>
      {options.map((o) => (
        <label key={String(o.value)} className="facet">
          <input type="radio" name={name} value={String(o.value)} defaultChecked={current === o.value} />
          <span>{label(o.value)}</span>
          <span className="facet-n">{o.count}</span>
        </label>
      ))}
    </fieldset>
  );
  return (
    <aside className="search-side">
      {/* The phone's drawer: a checkbox the button toggles, so it opens without JavaScript. */}
      <input type="checkbox" id="filter-open" className="filter-open" />
      <label htmlFor="filter-open" className="filter-toggle">
        <span aria-hidden="true">☰</span> {f.toggle}
        {active > 0 && <span className="filter-count">{active}</span>}
      </label>
      <form className="filter-side" method="GET" action="/search" aria-label={f.title}>
        <AutoSubmit />
        <input type="hidden" name="q" value={q} />
        {filters.model && <input type="hidden" name="model" value={filters.model} />}
        {filters.sort !== "best" && <input type="hidden" name="sort" value={filters.sort} />}

        <fieldset className="facet-group">
          <legend>{f.condition}</legend>
          {(["any", "new", "refurbished", "used"] as const)
            .filter((c) => c === "any" || fc.condition[c] > 0 || filters.condition === c)
            .map((c) => (
              <label key={c} className="facet">
                <input type="radio" name="cond" value={c} defaultChecked={filters.condition === c} />
                <span>{f[c]}</span>
                <span className="facet-n">{fc.condition[c]}</span>
              </label>
            ))}
        </fieldset>

        {(fc.market.length > 1 || filters.market) &&
          radios("market", f.market, filters.market, fc.market, marketLabel, fc.market.reduce((n, o) => n + o.count, 0))}

        <fieldset className="facet-group facet-price">
          <legend>{f.price}</legend>
          <div>
            <input name="min" inputMode="decimal" placeholder={f.min} aria-label={`${f.price} ${f.min}`} defaultValue={eur(filters.min)} />
            <span aria-hidden="true">–</span>
            <input name="max" inputMode="decimal" placeholder={f.max} aria-label={`${f.price} ${f.max}`} defaultValue={eur(filters.max)} />
          </div>
        </fieldset>

        {(fc.storage.length > 0 || filters.storage !== null) && radios("storage", f.storage, filters.storage, fc.storage, f.size)}
        {(fc.ram.length > 0 || filters.ram !== null) && radios("ram", f.ram, filters.ram, fc.ram, f.size)}
        {(fc.gen.length > 0 || filters.gen !== null) && radios("gen", f.gen, filters.gen, fc.gen, f.genValue)}

        <fieldset className="facet-group">
          <legend>{f.show}</legend>
          <label className="facet">
            <input type="checkbox" name="checked" value="1" defaultChecked={filters.checkedOnly} />
            <span>{f.checkedOnly}</span>
          </label>
          <label className="facet">
            <input type="checkbox" name="products" value="1" defaultChecked={filters.productsOnly} />
            <span>{f.productsOnly}</span>
          </label>
          {(fc.freeShipping > 0 || filters.freeShipping) && (
            <label className="facet">
              <input type="checkbox" name="ship" value="free" defaultChecked={filters.freeShipping} />
              <span>{f.freeShipping}</span>
              <span className="facet-n">{fc.freeShipping}</span>
            </label>
          )}
        </fieldset>

        <div className="filter-actions">
          <button type="submit" className="primary">
            {f.showResults}
          </button>
          {active > 0 && <a href={filterHref(q, { ...NO_FILTERS, sort: filters.sort })}>{f.clearAll}</a>}
        </div>
        <p className="hint filter-note">{f.note}</p>
      </form>
    </aside>
  );
}

/** The models found, as cards: one click shows only that model's offers (and another click, all again). */
function ModelCards({ q, filters, fc, currency }: { q: string; filters: Filters; fc: Facets; currency: string }) {
  const { m } = i18n();
  const f = m.search.filters;
  if (!fc.models.length) return null;
  return (
    <section className="model-cards" aria-labelledby="models-title">
      <h2 id="models-title">{f.models}</h2>
      <ul>
        {fc.models.map((c) => {
          const on = filters.model === c.key;
          return (
            <li key={c.key}>
              <a className={`model-card${on ? " on" : ""}`} href={filterHref(q, { ...filters, model: on ? null : c.key })} aria-current={on ? "true" : undefined}>
                <b>{modelName(q, c.key)}</b>
                {c.storages.length > 0 && <span className="model-sizes">{c.storages.map(f.size).join(" · ")}</span>}
                <span className="model-meta">
                  {f.offers(c.count)} · {c.from && c.from.currency === currency ? f.from(money(c.from)) : f.noneChecked}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Above the results: how many, the sort, and each filter in use with an × to take it off. */
function ResultsBar({ q, filters, shown, total, currency }: { q: string; filters: Filters; shown: number; total: number; currency: string }) {
  const { m } = i18n();
  const f = m.search.filters;
  const at = (cents: number) => money({ amount: cents, currency });
  const off = (patch: Partial<Filters>) => filterHref(q, { ...filters, ...patch });
  const chips: { label: string; href: string }[] = [
    filters.condition !== "any" && { label: f[filters.condition], href: off({ condition: "any" }) },
    filters.market && { label: marketLabel(filters.market), href: off({ market: null }) },
    (filters.min !== null || filters.max !== null) && {
      label: `${filters.min !== null ? at(filters.min) : ""} – ${filters.max !== null ? at(filters.max) : ""}`.trim(),
      href: off({ min: null, max: null }),
    },
    filters.model && { label: modelName(q, filters.model), href: off({ model: null }) },
    filters.storage !== null && { label: f.size(filters.storage), href: off({ storage: null }) },
    filters.ram !== null && { label: `${f.size(filters.ram)} RAM`, href: off({ ram: null }) },
    filters.gen !== null && { label: f.genValue(filters.gen), href: off({ gen: null }) },
    filters.checkedOnly && { label: f.checkedOnly, href: off({ checkedOnly: false }) },
    filters.productsOnly && { label: f.productsOnly, href: off({ productsOnly: false }) },
    filters.freeShipping && { label: f.freeShipping, href: off({ freeShipping: false }) },
  ].filter((c): c is { label: string; href: string } => !!c);
  const sorts = [
    ["best", f.best],
    ["price", f.priceUp],
    ["price-desc", f.priceDown],
  ] as const;
  return (
    <div className="results-bar">
      <div className="results-top">
        <p className="results-count">
          {shown === total ? <b>{f.offers(shown)}</b> : f.showing(shown, total)}
        </p>
        <nav className="sort-links" aria-label={f.sortedBy}>
          <span className="hint">{f.sortedBy}:</span>
          {sorts.map(([v, label]) => (
            <a key={v} href={off({ sort: v })} aria-current={filters.sort === v ? "true" : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </div>
      {chips.length > 0 && (
        <ul className="active-chips">
          {chips.map((c) => (
            <li key={c.label}>
              <a href={c.href} aria-label={f.remove(c.label)}>
                {c.label} <span aria-hidden="true">×</span>
              </a>
            </li>
          ))}
          {chips.length > 1 && (
            <li>
              <a className="clear" href={filterHref(q, { ...NO_FILTERS, sort: filters.sort })}>
                {f.clearAll}
              </a>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Once EVERY marketplace has answered: the checked results. */
async function SearchResults({
  q,
  filters,
  vapidKey,
  pending,
}: {
  q: string;
  filters: Filters;
  vapidKey: string | null;
  pending: Promise<SourceResult>[];
}) {
  // Upheld fake-product reports flag their seller's listings — and a flag
  // removes the pay button, so the same finding closes SigPath's checkout to them.
  // Read while the marketplaces answer: each is a round trip to the database.
  const [upheldReports, badgeEntries, businessEntries, answered] = await Promise.all([
    DecisionLog.fromEnv().upheldCounts(),
    VerifiedSellerLog.fromEnv().all(),
    BusinessLog.fromEnv().all(),
    Promise.all(pending),
  ]);
  const result = assembleSearch(q, answered, { limit: 20 }, { upheldReports });
  const businesses = businessIndex(businessEntries, badgeEntries, upheldReports);
  // Same as labelledSearch: a verified business's photo under an unlinked account on another marketplace.
  result.analysis = { ...result.analysis, flags: [...result.analysis.flags, ...verifiedPhotoFlags(result.listings, businesses)] };
  const businessOf = (l: Listing) => businesses.get(sellerKey(l.source, l.seller.handle)) ?? null;

  const a = result.analysis;
  // The market box and the median line under it read the same numbers.
  const groups = a?.status === "ok" ? marketSnapshot(result.listings, a) : [];
  const newGroup = groups.find((g) => g.group === "new");
  const badgeOf = (l: Listing) => badgeFor(sellerKey(l.source, l.seller.handle), badgeEntries, upheldReports);
  // Flags grouped by marketplace AND id, one verdict per listing, the best checked deals.
  const labelled = result ? labelSearch(result, (l) => badgeOf(l) !== null, businessOf) : null;
  const flagsOf = (l: Listing) => labelled?.flagsOf(l) ?? [];
  const labelOf = (l: Listing) => labelled!.labelOf(l);
  const deals = labelled?.deals ?? [];
  const checkedOnly = filters.checkedOnly;
  // SigPath-checked first; the rest follows in the search's own order (checkedFirst). Then the
  // shopper's filters and sort (lib/marketplace/filters.ts), which never change a verdict.
  const shown = applyFilters(checkedFirst(result?.listings ?? [], labelOf), filters, labelOf, a.identities ?? {});
  const dealOf = (l: Listing) => {
    if (labelOf(l).verdict !== "checked") return null;
    const pct = dealScore(l, a);
    const median = a.comparisons[listingKey(l)]?.median;
    return pct === null || median === undefined ? null : { pct, typical: { amount: median, currency: totalPrice(l).currency } };
  };
  const checkedCount = (result?.listings ?? []).filter((l) => labelOf(l).verdict === "checked").length;

  // Checkout is offered only when BOTH secrets exist: one to sign prices, one to
  // encrypt delivery addresses. Missing either, no listing gets a pay button.
  const checkoutReady = quoteSigningConfigured() && AddressStore.fromEnv() !== null;
  // The conversion shown on each pay button: the same ECB rate and service fee
  // the checkout charges. One rate fetch per page (it is cached), and none if
  // checkout is off. No rate: the button simply shows no amount.
  const feeBps = serviceFeeBps();
  const rate = checkoutReady ? await eurUsdRate().catch(() => null) : null;
  const usdcFor = (amount: number, currency: string) => {
    const item = toUsdcBaseUnits(amount, currency, currency.toUpperCase() === "USD" ? null : rate);
    return item === null ? undefined : usdcPreview(withServiceFee(item, feeBps).total);
  };
  const checkoutOffer = (l: Listing, flags: Flag[]): CheckoutOffer => {
    if (!checkoutReady || !a) return null;
    const e = checkoutEligibility(l, flags, priceCheckFor(l, a));
    if (!e.eligible) return { reason: e.reason };
    const total = totalPrice(l);
    const token = signQuote({
      source: l.source,
      id: l.id,
      url: l.url,
      title: l.title,
      seller: l.seller.handle,
      amount: total.amount,
      currency: total.currency,
    });
    return token ? { token, usdc: usdcFor(total.amount, total.currency) } : null;
  };

  const { m, tc, lang } = i18n();
  const fc = facets(checkedFirst(result.listings, labelOf), filters, labelOf, a.identities ?? {});
  const currency = a.currency ?? result.listings[0]?.price.currency ?? "EUR";

  // What the search found for the product as a whole: the same whatever the filters say.
  const overview = (
    <>
      {a?.status === "ok" && <MarketOverview groups={groups} currency={a.currency!} query={q} />}
      {a?.status === "ok" ? (
        <p className="hint market-scope">
          {/* New and used are compared separately, each against its own
              median — so both are shown when both could be computed. */}
          {m.search.median(
            [
              // The same numbers as the market box above, when it has a new group.
              newGroup
                ? (newGroup.withRefurbished ? m.search.newRefurbishedAcross : m.search.newAcross)(
                    money({ amount: newGroup.typical, currency: a.currency! }),
                    newGroup.count,
                  )
                : a.median !== undefined
                  ? // The overall median pools refurbished with new (anomaly.ts): say so when it does.
                    (newMedianHasRefurbished(result.listings, a) ? m.search.newRefurbishedAcross : m.search.newAcross)(
                      money({ amount: a.median, currency: a.currency! }),
                      a.sampleSize ?? 0,
                    )
                  : null,
              a.used ? m.search.usedAcross(money({ amount: a.used.median, currency: a.currency! }), a.used.sampleSize) : null,
            ]
              .filter(Boolean)
              .join("; "),
          )}
          {/* Real marketplaces and the demo feed are never pooled: say which one the median is from. */}
          {" "}
          {a.medianScope
            ? translateWhere(a.medianScope.trim(), lang)
            : a.coverage.length > 1
              ? m.search.onMarketplaces(a.coverage.length)
              : m.search.on(a.coverage[0] === "stub" ? m.search.demoFeed : marketLabel(a.coverage[0]))}
          .
          {a.excludedFromComparison.length > 0 && (
            // Says why a cheap listing from these carries no price flag.
            <> {m.search.notCompared(a.excludedFromComparison.map(marketLabel).join(", "))}</>
          )}
        </p>
      ) : (
        // Saying WHY there is no price comparison matters more than hiding
        // its absence. A buyer who thinks a check ran when it did not is
        // worse off than one who knows it did not.
        <p className="notice withheld">{a?.reason && tc(a.reason)}</p>
      )}
    </>
  );

  return (
    <>
      {/* Which marketplaces this answer actually rests on. */}
      <ul className="coverage">
        {/* Only marketplaces that were searched: a list of what isn't connected yet is noise. */}
        {result.sources.filter((s) => s.status !== "not_configured").map((s) => (
          <li
            key={s.source}
            className={
              s.status === "ok" ? "ok" : s.status === "not_configured" ? "" : "degraded"
            }
            title={m.search.sourceDetail(s.detail ?? "")}
          >
            {marketLabel(s.source)}: {m.search.status[s.status] ?? s.status}
            {s.status === "ok" && ` (${s.count})`}
          </li>
        ))}
      </ul>

      {result.listings.length === 0 ? (
        <>
          {overview}
          <p className="hint">{m.search.noListings(q)}</p>
        </>
      ) : (
        // Filters on the left, as shops lay them out; on a phone, behind a button above the results.
        <div className="search-layout">
          <FilterSidebar q={q} filters={filters} fc={fc} />
          <div className="search-main">
            {overview}

            {deals.length > 0 && (
              // The deal the shopper came for — restricted to listings that passed.
              <section className="best-deals">
                <h2>{m.search.bestDeals(deals.length)}</h2>
                <ul>
                  {deals.map((d) => (
                    <li key={d.group}>
                      <span className="deal-price">{money(d.total)}</span>{" "}
                      <span className="chip">{marketLabel(d.listing.source)}</span>{" "}
                      {/* The deal's own condition: refurbished shares the "new" group, but isn't new. */}
                      <span className="hint">{d.group === "used" ? m.search.usedWord : m.listing.conditions[d.listing.condition] ?? m.search.newWord}</span>
                      <br />
                      <a href={`#l-${listingKey(d.listing)}`}>{d.listing.title}</a>
                      {describeSaving(d) && <span className="saving"> &mdash; {tc(describeSaving(d)!)}</span>}
                      {vapidKey && <AlertButton query={q} group={d.group} current={d.total} vapidKey={vapidKey} />}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <ModelCards q={q} filters={filters} fc={fc} currency={currency} />

            <p className="hint label-explainer">
              {/* The full definition is in the API (CHECKED_MEANS); one line here. */}
              {m.search.checkedLine}{" "}
              {checkedOnly ? (
                <a href={filterHref(q, filters, { checked: "" })}>{m.search.showAll(result.listings.length)}</a>
              ) : (
                checkedCount > 0 && <a href={filterHref(q, filters, { checked: "1" })}>{m.search.showChecked(checkedCount)}</a>
              )}
            </p>
            {checkoutReady && rate && (
              <p className="hint">
                {feeBps > 0 ? m.search.usdcRate(rate.display, rate.source, formatFeeRate(feeBps)) : m.search.usdcRateFree(rate.display, rate.source)}
              </p>
            )}

            <ResultsBar q={q} filters={filters} shown={shown.length} total={result.listings.length} currency={currency} />

            {shown.length === 0 ? (
              <p className="notice">
                {m.search.filters.none}{" "}
                <a href={filterHref(q, { ...NO_FILTERS, sort: filters.sort })}>{m.search.filters.reset}</a>
              </p>
            ) : (
              // A grid of boxes, as shops show products: photo, name and price first, SigPath's verdict under them.
              <div className="listing-grid">
                {shown.map((l) => (
                  <ListingRow
                    key={listingKey(l)}
                    listing={l}
                    flags={flagsOf(l)}
                    checkout={checkoutOffer(l, flagsOf(l))}
                    badge={badgeOf(l)}
                    business={businessOf(l)}
                    label={labelOf(l)}
                    // A score only where SigPath vouches for the price: a flagged "−60%" is bait, not a deal.
                    deal={dealOf(l)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* The marketplaces we cover but are not permitted to query. One
          click each rather than nothing — and deliberately separated from
          the results above, because no price here reached the median and
          implying otherwise would overstate the comparison. */}
      {result.linkOut.length > 0 && (
        <section className="linkout">
          <h2>{m.search.alsoSearch}</h2>
          <p className="hint">{m.search.notInComparison}</p>
          <ul>
            {result.linkOut.map((t) => (
              <li key={t.id}>
                <a href={t.url} target="_blank" rel={t.affiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}>
                  {t.label} &rarr;
                </a>
                {t.note && <span className="hint"> {m.search.linkNotes[t.id] ?? t.note}</span>}
              </li>
            ))}
          </ul>
          {result.linkOut.some((t) => t.affiliate) && (
            // Amazon requires this disclosure wherever an Associates link appears.
            <p className="hint affiliate-note">
              {m.search.amazonNote}
            </p>
          )}
        </section>
      )}
    </>
  );
}
